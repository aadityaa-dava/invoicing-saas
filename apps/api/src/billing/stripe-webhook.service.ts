import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { TenantDb, type TenantTx } from '../tenancy/tenant-db.service';
import { isEntitledStatus } from './plans';
import {
  STRIPE_GATEWAY,
  type StripeEvent,
  type StripeGateway,
  type SubscriptionSnapshot,
} from './stripe.gateway';

type Outcome = 'processed' | 'ignored' | 'unmatched';

type Action =
  | {
      kind: 'invoice_paid';
      orgId: string;
      invoiceId: string;
      sessionId: string;
      paymentIntentId: string;
      amountCents: number;
      currency: string;
    }
  | { kind: 'subscription'; orgId: string; subscriptionId: string }
  | { kind: 'ignored'; orgId: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const asUuid = (v: unknown): string | undefined => {
  const s = asString(v);
  return s && UUID.test(s) ? s : undefined;
};

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDb,
    private readonly config: ConfigService<Env, true>,
    @Inject(STRIPE_GATEWAY) private readonly stripe: StripeGateway,
  ) {}

  async handle(rawBody: Buffer | undefined, signature: string | undefined) {
    const event = this.verify(rawBody, signature);
    const action = this.parse(event);

    // Fetched before the transaction opens, so no network call ever happens
    // while a lock is held. A failure here returns 500 and Stripe retries.
    const snapshot =
      action.kind === 'subscription'
        ? await this.stripe.retrieveSubscription(action.subscriptionId)
        : undefined;

    if (action.kind === 'ignored') {
      await this.prisma.$transaction((tx) =>
        this.once(tx, event, action.orgId, async () => 'ignored' as const),
      );
    } else {
      await this.tenantDb.run({ orgId: action.orgId }, (tx) =>
        this.once(tx, event, action.orgId, () =>
          action.kind === 'invoice_paid'
            ? this.applyInvoicePaid(tx, action)
            : this.applySubscription(tx, action, snapshot!),
        ),
      );
    }
    return { received: true };
  }

  private verify(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): StripeEvent {
    if (!rawBody || !signature) {
      throw new BadRequestException({ code: 'invalid_signature' });
    }
    try {
      return this.stripe.constructEvent(rawBody, signature);
    } catch (error) {
      // Billing not configured is a 503, anything else is a bad signature.
      if (error instanceof HttpException) throw error;
      throw new BadRequestException({ code: 'invalid_signature' });
    }
  }

  private parse(event: StripeEvent): Action {
    const object = event.data.object;
    const orgId = asUuid(asRecord(object.metadata).orgId);

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        if (object.mode === 'subscription') {
          const subscriptionId = asString(object.subscription);
          return orgId && subscriptionId
            ? { kind: 'subscription', orgId, subscriptionId }
            : { kind: 'ignored', orgId: orgId ?? null };
        }
        // An unpaid completed session (delayed payment method) is settled
        // later by the async_payment_succeeded event.
        if (object.mode !== 'payment' || object.payment_status !== 'paid') {
          return { kind: 'ignored', orgId: orgId ?? null };
        }
        const invoiceId = asUuid(asRecord(object.metadata).invoiceId);
        const sessionId = asString(object.id);
        const paymentIntentId = asString(object.payment_intent);
        const currency = asString(object.currency);
        const amount = object.amount_total;
        if (
          !orgId ||
          !invoiceId ||
          !sessionId ||
          !paymentIntentId ||
          !currency ||
          typeof amount !== 'number'
        ) {
          this.logger.warn(
            `paid checkout session in event ${event.id} is missing metadata or payment details`,
          );
          return { kind: 'ignored', orgId: orgId ?? null };
        }
        return {
          kind: 'invoice_paid',
          orgId,
          invoiceId,
          sessionId,
          paymentIntentId,
          amountCents: amount,
          currency,
        };
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscriptionId = asString(object.id);
        return orgId && subscriptionId
          ? { kind: 'subscription', orgId, subscriptionId }
          : { kind: 'ignored', orgId: orgId ?? null };
      }
      default:
        return { kind: 'ignored', orgId: null };
    }
  }

  // Runs the effect and records the event in one transaction. The advisory
  // lock makes concurrent deliveries of the same event wait for each other, so
  // the second one sees the recorded event and does nothing. The primary key
  // on webhook_events is the final backstop.
  private async once(
    tx: TenantTx,
    event: StripeEvent,
    orgId: string | null,
    work: () => Promise<Outcome>,
  ) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${event.id}))`;
    const seen = await tx.webhookEvent.findUnique({
      where: { stripeEventId: event.id },
      select: { stripeEventId: true },
    });
    if (seen) return 'duplicate' as const;
    const outcome = await work();
    await tx.webhookEvent.create({
      data: { stripeEventId: event.id, type: event.type, outcome, orgId },
    });
    return outcome;
  }

  private async applyInvoicePaid(
    tx: TenantTx,
    a: Extract<Action, { kind: 'invoice_paid' }>,
  ): Promise<Outcome> {
    // Row-level security means another organization's invoice is invisible.
    const rows = await tx.$queryRaw<
      { status: string; total: bigint; currency: string }[]
    >`SELECT status::text AS status, total_cents AS total, currency
      FROM invoices
      WHERE id = ${a.invoiceId}::uuid AND deleted_at IS NULL
      FOR UPDATE`;
    const invoice = rows[0];
    if (!invoice) {
      this.logger.warn(
        `payment ${a.paymentIntentId} references unknown invoice ${a.invoiceId}`,
      );
      return 'unmatched';
    }

    // The same payment can arrive under another event id.
    const existing = await tx.payment.findUnique({
      where: { stripePaymentIntentId: a.paymentIntentId },
      select: { id: true },
    });
    if (existing) return 'ignored';

    if (
      Number(invoice.total) !== a.amountCents ||
      invoice.currency.toUpperCase() !== a.currency.toUpperCase()
    ) {
      this.logger.error(
        `payment ${a.paymentIntentId} does not match invoice ${a.invoiceId}: ` +
          `paid ${a.amountCents} ${a.currency}, expected ${Number(invoice.total)} ${invoice.currency}. Needs manual reconciliation.`,
      );
      return 'unmatched';
    }

    const settles = invoice.status === 'sent' || invoice.status === 'overdue';
    await tx.payment.create({
      data: {
        orgId: a.orgId,
        invoiceId: a.invoiceId,
        amountCents: BigInt(a.amountCents),
        currency: a.currency.toUpperCase(),
        stripePaymentIntentId: a.paymentIntentId,
        stripeCheckoutSessionId: a.sessionId,
        status: settles ? 'succeeded' : 'duplicate',
      },
    });
    if (settles) {
      await tx.invoice.update({
        where: { id: a.invoiceId },
        data: { status: 'PAID', paidAt: new Date() },
      });
    } else {
      this.logger.warn(
        `payment ${a.paymentIntentId} arrived for invoice ${a.invoiceId} in status ${invoice.status}. Recorded as duplicate, refund manually.`,
      );
    }
    return 'processed';
  }

  private async applySubscription(
    tx: TenantTx,
    a: Extract<Action, { kind: 'subscription' }>,
    snapshot: SubscriptionSnapshot,
  ): Promise<Outcome> {
    const org = await tx.organization.findUnique({
      where: { id: a.orgId },
      select: { stripeCustomerId: true },
    });
    // The metadata names the organization, the customer proves it.
    if (
      !org ||
      !org.stripeCustomerId ||
      org.stripeCustomerId !== snapshot.customerId
    ) {
      this.logger.error(
        `subscription ${snapshot.id} does not belong to organization ${a.orgId}`,
      );
      return 'unmatched';
    }

    const existing = await tx.subscription.findUnique({
      where: { orgId: a.orgId },
    });
    // A late event about a replaced subscription must not undo the current one.
    if (
      existing &&
      existing.stripeSubscriptionId !== snapshot.id &&
      isEntitledStatus(existing.status) &&
      !isEntitledStatus(snapshot.status)
    ) {
      return 'ignored';
    }

    const proPrice = this.config.get('STRIPE_PRICE_PRO', { infer: true });
    const plan = proPrice && snapshot.priceId === proPrice ? 'pro' : 'free';
    const data = {
      plan,
      status: snapshot.status,
      stripeSubscriptionId: snapshot.id,
      currentPeriodEnd: snapshot.currentPeriodEnd,
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    };
    await tx.subscription.upsert({
      where: { orgId: a.orgId },
      create: { orgId: a.orgId, ...data },
      update: data,
    });
    return 'processed';
  }
}
