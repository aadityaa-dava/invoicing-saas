// Everything the application needs from Stripe, as plain types. Application
// code depends on this interface only, never on the SDK, so tests can use a
// fake and nothing needs network access or a key.

export const STRIPE_GATEWAY = Symbol('STRIPE_GATEWAY');

export type CheckoutSession = { id: string; url: string };

export type SubscriptionSnapshot = {
  id: string;
  customerId: string;
  status: string;
  priceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
};

// A verified webhook event. `data.object` is the raw Stripe object and is
// only read through narrow accessors in the webhook handlers.
export type StripeEvent = {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
};

export interface StripeGateway {
  createCustomer(input: {
    orgId: string;
    name: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;

  createInvoiceCheckout(input: {
    orgId: string;
    invoiceId: string;
    invoiceNumber: string;
    currency: string;
    amountCents: number;
    customerEmail?: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<CheckoutSession>;

  createSubscriptionCheckout(input: {
    orgId: string;
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<CheckoutSession>;

  // Expiring a session that is already completed or expired is not an error.
  expireCheckout(sessionId: string): Promise<void>;

  createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;

  retrieveSubscription(subscriptionId: string): Promise<SubscriptionSnapshot>;

  // Verifies the signature over the exact raw bytes and the timestamp
  // tolerance. Throws if the signature is missing or invalid.
  constructEvent(rawBody: Buffer, signature: string): StripeEvent;
}
