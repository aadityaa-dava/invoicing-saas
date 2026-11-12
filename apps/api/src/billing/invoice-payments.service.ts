import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { TenantDb } from '../tenancy/tenant-db.service';
import { STRIPE_GATEWAY, type StripeGateway } from './stripe.gateway';

// Stripe accepts card amounts from about 0.50 up to 999,999.99 (8 digits).
export const MIN_ONLINE_AMOUNT_CENTS = 50;
export const MAX_ONLINE_AMOUNT_CENTS = 99_999_999;

const notFound = () => new NotFoundException({ code: 'invoice_not_found' });
const notPayable = () => new ConflictException({ code: 'invoice_not_payable' });

@Injectable()
export class InvoicePaymentsService {
  private readonly logger = new Logger(InvoicePaymentsService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly config: ConfigService<Env, true>,
    @Inject(STRIPE_GATEWAY) private readonly stripe: StripeGateway,
  ) {}

  // Creates a hosted checkout page for one invoice. The amount and currency
  // come from the database, never from the caller. Stripe is called outside
  // any transaction so a slow request never holds a row lock.
  async createPaymentLink(userId: string, orgId: string, id: string) {
    const snapshot = await this.tenantDb.run({ userId, orgId }, async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id, deletedAt: null },
        select: {
          status: true,
          number: true,
          currency: true,
          totalCents: true,
          clientId: true,
          stripeCheckoutSessionId: true,
        },
      });
      if (!invoice) throw notFound();
      if (invoice.status !== 'SENT' && invoice.status !== 'OVERDUE') {
        throw notPayable();
      }
      const amountCents = Number(invoice.totalCents);
      if (amountCents < MIN_ONLINE_AMOUNT_CENTS) {
        throw new UnprocessableEntityException({
          code: 'amount_too_small_for_online_payment',
        });
      }
      if (amountCents > MAX_ONLINE_AMOUNT_CENTS) {
        throw new UnprocessableEntityException({
          code: 'amount_too_large_for_online_payment',
        });
      }
      const client = await tx.client.findFirst({
        where: { id: invoice.clientId },
        select: { email: true },
      });
      return {
        invoiceNumber: invoice.number ?? '',
        currency: invoice.currency,
        amountCents,
        customerEmail: client?.email ?? undefined,
        previousSessionId: invoice.stripeCheckoutSessionId,
      };
    });

    const webUrl = this.config.get('WEB_URL', { infer: true });
    // Chained on the previous session: a retry or a concurrent identical
    // request gets the same session back, a later request gets a new one.
    const session = await this.stripe.createInvoiceCheckout({
      orgId,
      invoiceId: id,
      invoiceNumber: snapshot.invoiceNumber,
      currency: snapshot.currency,
      amountCents: snapshot.amountCents,
      customerEmail: snapshot.customerEmail,
      successUrl: `${webUrl}/payments/success`,
      cancelUrl: `${webUrl}/payments/cancelled`,
      idempotencyKey: `invoice-pay-${id}-${snapshot.previousSessionId ?? 'first'}`,
    });

    const outcome = await this.tenantDb.run({ userId, orgId }, async (tx) => {
      const rows = await tx.$queryRaw<
        { status: string; session: string | null }[]
      >`SELECT status::text AS status,
               stripe_checkout_session_id AS session
        FROM invoices
        WHERE id = ${id}::uuid AND deleted_at IS NULL
        FOR UPDATE`;
      const row = rows[0];
      if (!row) throw notFound();
      // Paid or voided while Stripe was being called.
      if (row.status !== 'sent' && row.status !== 'overdue') {
        return { stored: false, previous: null };
      }
      await tx.invoice.update({
        where: { id },
        data: { stripeCheckoutSessionId: session.id },
      });
      return {
        stored: true,
        previous:
          row.session && row.session !== session.id ? row.session : null,
      };
    });

    if (!outcome.stored) {
      await this.expireQuietly(session.id);
      throw notPayable();
    }
    // One open session per invoice: retire the one this replaces.
    if (outcome.previous) await this.expireQuietly(outcome.previous);
    return { url: session.url };
  }

  private async expireQuietly(sessionId: string) {
    try {
      await this.stripe.expireCheckout(sessionId);
    } catch (error) {
      this.logger.warn(
        `could not expire checkout session ${sessionId}: ${(error as Error).message}`,
      );
    }
  }
}
