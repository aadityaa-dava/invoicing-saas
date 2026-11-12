import Stripe from 'stripe';
import type {
  CheckoutSession,
  StripeEvent,
  StripeGateway,
  SubscriptionSnapshot,
} from './stripe.gateway';

export class StripeApiGateway implements StripeGateway {
  constructor(
    private readonly stripe: Stripe,
    private readonly webhookSecret: string | undefined,
  ) {}

  async createCustomer(input: {
    orgId: string;
    name: string;
    idempotencyKey: string;
  }) {
    const customer = await this.stripe.customers.create(
      { name: input.name, metadata: { orgId: input.orgId } },
      { idempotencyKey: input.idempotencyKey },
    );
    return { id: customer.id };
  }

  async createInvoiceCheckout(input: {
    orgId: string;
    invoiceId: string;
    invoiceNumber: string;
    currency: string;
    amountCents: number;
    customerEmail?: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<CheckoutSession> {
    const metadata = { orgId: input.orgId, invoiceId: input.invoiceId };
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        client_reference_id: input.invoiceId,
        customer_email: input.customerEmail,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.amountCents,
              product_data: { name: `Invoice ${input.invoiceNumber}` },
            },
          },
        ],
        metadata,
        payment_intent_data: { metadata },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return toCheckoutSession(session);
  }

  async createSubscriptionCheckout(input: {
    orgId: string;
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
  }): Promise<CheckoutSession> {
    const metadata = { orgId: input.orgId };
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: input.customerId,
        client_reference_id: input.orgId,
        line_items: [{ price: input.priceId, quantity: 1 }],
        metadata,
        subscription_data: { metadata },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return toCheckoutSession(session);
  }

  async expireCheckout(sessionId: string): Promise<void> {
    try {
      await this.stripe.checkout.sessions.expire(sessionId);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError) return;
      throw error;
    }
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }) {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }

  async retrieveSubscription(
    subscriptionId: string,
  ): Promise<SubscriptionSnapshot> {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    return {
      id: sub.id,
      customerId:
        typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
      status: sub.status,
      priceId: item?.price.id ?? null,
      currentPeriodEnd: item?.current_period_end
        ? new Date(item.current_period_end * 1000)
        : null,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    };
  }

  constructEvent(rawBody: Buffer, signature: string): StripeEvent {
    if (!this.webhookSecret) {
      throw new Error('Webhook signing secret is not configured');
    }
    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.webhookSecret,
    );
    return {
      id: event.id,
      type: event.type,
      created: event.created,
      data: { object: event.data.object as unknown as Record<string, unknown> },
    };
  }
}

function toCheckoutSession(session: Stripe.Checkout.Session): CheckoutSession {
  if (!session.url) throw new Error('Stripe returned a session without a URL');
  return { id: session.id, url: session.url };
}
