# ADR-0007: Billing, invoice payments and Stripe webhooks

- Status: Accepted
- Date: 2026-11-11

## Context

Two separate money flows exist, and they must not be mixed up:

1. The product bills its own customers. Each organization has a plan, and a
   paid plan unlocks features. This is a subscription.
2. Organizations bill their clients. A client pays an invoice online and the
   invoice becomes `paid`. This is a one-off payment.

Stripe reports the outcome of both by webhook, and a webhook is a public,
unauthenticated request that Stripe will retry, duplicate and deliver out of
order. The project must also stay at zero cost, so only Stripe test mode is
allowed.

## Decision

### Test mode only, enforced

`STRIPE_SECRET_KEY` must start with `sk_test_` or the API refuses to boot.
A live key is rejected by validation, not by convention. Allowing live mode
later is a deliberate code change that shows up in review.

### Stripe behind one interface

All Stripe calls go through a `StripeGateway` (create customer, create and
expire checkout session, create portal session, retrieve subscription, verify
a webhook signature). Application code never imports the SDK directly. Tests
inject a fake gateway and sign webhook payloads locally, so the suite and CI
need no network, no key and no Stripe account. A manual smoke test with the
Stripe CLI (`stripe listen`, `stripe trigger`) is documented but not part of
the suite.

### Webhooks are the source of truth

An invoice becomes `paid` and a plan becomes active only from a verified
webhook. The browser redirect after checkout is informational: it can be
faked, abandoned or never happen.

Endpoint rules:
- Public route outside the normal auth guards, reading the raw body, because
  signature verification is computed over the exact bytes. Signature and
  timestamp tolerance are checked first. An invalid signature gets 400 and
  does no work.
- Idempotent through `webhook_events` with the Stripe event id as primary key.
  The event row is inserted in the same transaction as its effect, using
  insert-or-ignore. A duplicate delivery therefore finds the row and returns
  200 without doing anything, and a crash before commit leaves no row, so the
  retry processes it normally.
- Processed inside the request, in one database transaction, and answered
  quickly. A failure returns 500 and Stripe retries for days. The alternative,
  enqueueing and acknowledging immediately, creates a window where an
  acknowledged event is lost, which is worse than a slightly slower response
  for a few small writes.
- Event types that are not handled are recorded and acknowledged with 200,
  so Stripe does not retry something that will never succeed.
- No tenant exists on a webhook request. The organization comes from metadata
  that the server itself attached when it created the session, and it is never
  trusted on its own: the work runs under that organization's row-level
  security, and the invoice must exist inside it. If it does not, the event is
  recorded as unmatched and logged.
- Events can arrive out of order. For subscription events the handler fetches
  the current subscription from Stripe by id and stores that state, instead of
  applying the payload in arrival order.

### Paying an invoice

A Checkout Session in payment mode is created on demand for one invoice
(`invoice:send` permission). It is created from database values only: the
amount is the invoice total in minor units, the currency is the invoice
currency, and the client never supplies an amount. Metadata carries the
organization and invoice ids. Only `sent` and `overdue` invoices can be paid.

Only one session stays open per invoice: the previous open session is expired
when a new one is created, and its id is stored on the invoice. Sessions
expire on their own after 24 hours.

On `checkout.session.completed` with a paid status, the handler checks that
the session amount and currency equal the invoice total, then records a
`payments` row and moves the invoice to `paid` with a paid date. A mismatch
does not mark anything paid and is logged at error level. If the invoice is
already `paid` (two sessions completed), the payment is recorded and flagged
as a duplicate for a manual refund, and the invoice is unchanged. The payment
intent id is unique, so a replay cannot record the same payment twice.
Allowed transitions: `sent -> paid` and `overdue -> paid`.

### Organization subscription

One paid plan (`pro`) next to the default `free`. Owners only
(`billing:manage`). Checkout in subscription mode and the Stripe customer
portal handle everything about the card, plan changes and cancellation, so no
card data and no billing screens are built here.

The Stripe customer is created lazily on first checkout, with an idempotency
key per organization and a conditional update
(`stripe_customer_id IS NULL`), so two concurrent first checkouts cannot create
two customers for one organization.

Local state mirrors Stripe: plan, status, current period end. Entitlement
rule: `active`, `trialing` and `past_due` keep the paid plan (Stripe is still
retrying the card), and `canceled`, `unpaid` and `incomplete_expired` fall back
to `free`.

What the paid plan unlocks: recurring invoice templates and auto-send. Free
organizations keep everything else, including manual invoicing and online
payment. Creating or resuming a template needs the paid plan. On downgrade,
existing templates are kept but generate nothing while the organization is on
the free plan, and generation logs the skip. Nothing is deleted.

### Out of scope on purpose

- No Stripe Connect. Invoice payments land in the single platform account.
  A real product would use Connect so funds go to the organization that
  issued the invoice. That is an onboarding and compliance project of its own
  and cannot be tested end to end at zero cost, so it is documented, not faked.
- No refunds, disputes, partial payments, proration, tax calculation or
  multiple prices. Those events are recorded and acknowledged only.

## Consequences

- Payment state can lag behind the real payment by the webhook delay. The UI
  must treat "payment submitted" and "paid" as different states.
- `webhook_events` is global, not tenant-owned, so it has no row-level
  security. It stores ids, type and outcome only, never payloads or card data.
- Webhook processing runs in the request path, so a slow database slows the
  acknowledgement. Stripe retries make that safe.
- A duplicate payment needs a human to refund it. It is detected and flagged,
  not automated.
- The platform account holding invoice payments is a simplification that must
  be called out clearly in the README.
