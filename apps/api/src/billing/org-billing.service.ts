import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { TenantDb } from '../tenancy/tenant-db.service';
import { hasPaidPlan } from './plans';
import { STRIPE_GATEWAY, type StripeGateway } from './stripe.gateway';

@Injectable()
export class OrgBillingService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly config: ConfigService<Env, true>,
    @Inject(STRIPE_GATEWAY) private readonly stripe: StripeGateway,
  ) {}

  // The plan is derived from the stored subscription with one shared rule.
  get(userId: string, orgId: string) {
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      const org = await tx.organization.findUnique({
        where: { id: orgId },
        select: { stripeCustomerId: true },
      });
      if (!org) throw new NotFoundException({ code: 'organization_not_found' });
      const subscription = await tx.subscription.findUnique({
        where: { orgId },
      });
      return {
        plan: hasPaidPlan(subscription) ? 'pro' : 'free',
        status: subscription?.status ?? null,
        currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        hasBillingAccount: Boolean(org.stripeCustomerId),
      };
    });
  }

  async createCheckoutSession(userId: string, orgId: string) {
    const priceId = this.config.get('STRIPE_PRICE_PRO', { infer: true });
    if (!priceId) {
      throw new ServiceUnavailableException({ code: 'billing_not_configured' });
    }
    const current = await this.get(userId, orgId);
    if (current.plan === 'pro') {
      throw new ConflictException({ code: 'already_subscribed' });
    }

    const customerId = await this.ensureCustomer(userId, orgId);
    const webUrl = this.config.get('WEB_URL', { infer: true });
    // Bucketed by hour: a double click or a retry gets the same session back.
    const hour = new Date().toISOString().slice(0, 13);
    const session = await this.stripe.createSubscriptionCheckout({
      orgId,
      customerId,
      priceId,
      successUrl: `${webUrl}/billing/success`,
      cancelUrl: `${webUrl}/billing/cancelled`,
      idempotencyKey: `org-sub-${orgId}-${hour}`,
    });
    return { url: session.url };
  }

  async createPortalSession(userId: string, orgId: string) {
    const customerId = await this.tenantDb.run(
      { userId, orgId },
      async (tx) =>
        (
          await tx.organization.findUnique({
            where: { id: orgId },
            select: { stripeCustomerId: true },
          })
        )?.stripeCustomerId,
    );
    if (!customerId) {
      throw new ConflictException({ code: 'no_billing_account' });
    }
    const webUrl = this.config.get('WEB_URL', { infer: true });
    return this.stripe.createPortalSession({
      customerId,
      returnUrl: `${webUrl}/billing`,
    });
  }

  // Created on first use. The idempotency key makes concurrent first calls
  // return the same Stripe customer, and the conditional update keeps the
  // first value that was stored.
  private async ensureCustomer(userId: string, orgId: string): Promise<string> {
    const org = await this.tenantDb.run({ userId, orgId }, (tx) =>
      tx.organization.findUnique({
        where: { id: orgId },
        select: { name: true, stripeCustomerId: true },
      }),
    );
    if (!org) throw new NotFoundException({ code: 'organization_not_found' });
    if (org.stripeCustomerId) return org.stripeCustomerId;

    const created = await this.stripe.createCustomer({
      orgId,
      name: org.name,
      idempotencyKey: `org-customer-${orgId}`,
    });
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      await tx.organization.updateMany({
        where: { id: orgId, stripeCustomerId: null },
        data: { stripeCustomerId: created.id },
      });
      const stored = await tx.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { stripeCustomerId: true },
      });
      return stored.stripeCustomerId!;
    });
  }
}
