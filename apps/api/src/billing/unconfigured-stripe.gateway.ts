import { ServiceUnavailableException } from '@nestjs/common';
import type { StripeGateway } from './stripe.gateway';

// Used when no Stripe key is configured, so the API still boots (CI, a fresh
// clone) and billing endpoints answer with a clear 503 instead of crashing.
function unavailable(): never {
  throw new ServiceUnavailableException({
    code: 'billing_not_configured',
    message: 'Billing is not configured on this server',
  });
}

export class UnconfiguredStripeGateway implements StripeGateway {
  createCustomer = unavailable;
  createInvoiceCheckout = unavailable;
  createSubscriptionCheckout = unavailable;
  expireCheckout = unavailable;
  createPortalSession = unavailable;
  retrieveSubscription = unavailable;
  constructEvent = unavailable;
}
