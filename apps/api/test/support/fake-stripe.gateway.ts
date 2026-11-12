import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { StripeApiGateway } from '../../src/billing/stripe-api.gateway';
import type {
  CheckoutSession,
  StripeEvent,
  StripeGateway,
  SubscriptionSnapshot,
} from '../../src/billing/stripe.gateway';

export const TEST_WEBHOOK_SECRET = 'whsec_testsecret0123456789';

type InvoiceCheckoutInput = Parameters<
  StripeGateway['createInvoiceCheckout']
>[0];
type SubscriptionCheckoutInput = Parameters<
  StripeGateway['createSubscriptionCheckout']
>[0];

// In-memory stand-in for Stripe. It emulates idempotency keys, so a repeated
// request returns the same object, and it verifies webhook signatures with the
// real gateway code, so signature handling is tested for real, offline.
export class FakeStripeGateway implements StripeGateway {
  customers: { id: string; orgId: string; name: string }[] = [];
  invoiceCheckouts: (InvoiceCheckoutInput & {
    id: string;
    expired: boolean;
  })[] = [];
  subscriptionCheckouts: (SubscriptionCheckoutInput & { id: string })[] = [];
  portalSessions: { customerId: string; returnUrl: string }[] = [];
  subscriptions = new Map<string, SubscriptionSnapshot>();
  failExpire = false;

  // Lets a test hold invoice-checkout creation open, to force two requests to
  // overlap. `entered` counts how many calls have reached the gateway.
  gate?: Promise<void>;
  entered = 0;

  private readonly byKey = new Map<string, unknown>();
  private readonly sdk = new Stripe('sk_test_00000000');
  private readonly verifier = new StripeApiGateway(
    this.sdk,
    TEST_WEBHOOK_SECRET,
  );

  private once<T>(key: string, create: () => T): T {
    if (this.byKey.has(key)) return this.byKey.get(key) as T;
    const value = create();
    this.byKey.set(key, value);
    return value;
  }

  async createCustomer(input: {
    orgId: string;
    name: string;
    idempotencyKey: string;
  }) {
    return this.once(input.idempotencyKey, () => {
      const customer = {
        id: `cus_${randomUUID().replaceAll('-', '').slice(0, 14)}`,
        orgId: input.orgId,
        name: input.name,
      };
      this.customers.push(customer);
      return { id: customer.id };
    });
  }

  async createInvoiceCheckout(
    input: InvoiceCheckoutInput,
  ): Promise<CheckoutSession> {
    this.entered++;
    if (this.gate) await this.gate;
    return this.once(input.idempotencyKey, () => {
      const id = `cs_test_${randomUUID().replaceAll('-', '')}`;
      this.invoiceCheckouts.push({ ...input, id, expired: false });
      return { id, url: `https://checkout.stripe.test/pay/${id}` };
    });
  }

  async createSubscriptionCheckout(
    input: SubscriptionCheckoutInput,
  ): Promise<CheckoutSession> {
    return this.once(input.idempotencyKey, () => {
      const id = `cs_test_${randomUUID().replaceAll('-', '')}`;
      this.subscriptionCheckouts.push({ ...input, id });
      return { id, url: `https://checkout.stripe.test/subscribe/${id}` };
    });
  }

  async expireCheckout(sessionId: string): Promise<void> {
    if (this.failExpire) throw new Error('stripe is down');
    const session = this.invoiceCheckouts.find((c) => c.id === sessionId);
    if (session) session.expired = true;
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }) {
    this.portalSessions.push(input);
    return { url: `https://billing.stripe.test/portal/${input.customerId}` };
  }

  async retrieveSubscription(
    subscriptionId: string,
  ): Promise<SubscriptionSnapshot> {
    const snapshot = this.subscriptions.get(subscriptionId);
    if (!snapshot) throw new Error(`unknown subscription ${subscriptionId}`);
    return snapshot;
  }

  constructEvent(rawBody: Buffer, signature: string): StripeEvent {
    return this.verifier.constructEvent(rawBody, signature);
  }

  // Builds a correctly signed webhook request body and header.
  sign(event: {
    id: string;
    type: string;
    data: { object: Record<string, unknown> };
  }) {
    const body = JSON.stringify({
      object: 'event',
      created: Math.floor(Date.now() / 1000),
      ...event,
    });
    const signature = this.sdk.webhooks.generateTestHeaderString({
      payload: body,
      secret: TEST_WEBHOOK_SECRET,
    });
    return { body, signature };
  }
}
