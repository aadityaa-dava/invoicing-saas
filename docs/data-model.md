# Data model

Companion to ADR-0001 (tenancy), ADR-0002 (auth) and ADR-0003 (ORM).

## ERD

```mermaid
erDiagram
    users ||--o{ memberships : has
    organizations ||--o{ memberships : has
    users ||--o{ refresh_tokens : owns
    users ||--o{ auth_tokens : owns
    organizations ||--o{ clients : has
    organizations ||--o{ invoices : has
    clients ||--o{ invoices : billed_on
    invoices ||--|{ invoice_line_items : contains
    invoices ||--o{ payments : receives
    organizations ||--o| subscriptions : has
    organizations ||--|| invoice_counters : numbers_with
    organizations ||--o{ recurring_templates : schedules
    recurring_templates ||--o{ invoices : generates
    organizations ||--o{ audit_logs : records

    users {
        uuid id PK
        text email UK
        text password_hash
        timestamptz email_verified_at
        timestamptz created_at
    }
    organizations {
        uuid id PK
        text name
        text slug UK
        text stripe_customer_id
        timestamptz created_at
    }
    memberships {
        uuid id PK
        uuid org_id FK
        uuid user_id FK
        text role "owner admin member viewer"
        timestamptz created_at
    }
    refresh_tokens {
        uuid id PK
        uuid user_id FK
        uuid family_id
        text token_hash UK
        timestamptz expires_at
        timestamptz used_at
        timestamptz revoked_at
    }
    auth_tokens {
        uuid id PK
        uuid user_id FK
        text type "email_verify password_reset"
        text token_hash UK
        timestamptz expires_at
        timestamptz used_at
    }
    clients {
        uuid id PK
        uuid org_id FK
        text name
        text email
        text billing_address
        text tax_id
        timestamptz deleted_at
    }
    invoices {
        uuid id PK
        uuid org_id FK
        uuid client_id FK
        uuid recurring_template_id FK
        text number "unique per org"
        text status "draft sent paid overdue void"
        char currency
        date issue_date
        date due_date
        bigint subtotal_cents
        bigint tax_cents
        bigint total_cents
        text stripe_payment_link_url
        timestamptz sent_at
        timestamptz paid_at
        timestamptz deleted_at
    }
    invoice_line_items {
        uuid id PK
        uuid org_id FK
        uuid invoice_id FK
        int position
        text description
        numeric quantity
        bigint unit_price_cents
        int tax_rate_bps
        bigint line_total_cents
        bigint line_tax_cents
    }
    payments {
        uuid id PK
        uuid org_id FK
        uuid invoice_id FK
        bigint amount_cents
        text stripe_payment_intent_id UK
        text status
        timestamptz created_at
    }
    subscriptions {
        uuid id PK
        uuid org_id FK
        text plan
        text status
        text stripe_subscription_id UK
        timestamptz current_period_end
    }
    invoice_counters {
        uuid org_id PK
        int next_number
    }
    recurring_templates {
        uuid id PK
        uuid org_id FK
        uuid client_id FK
        text frequency "weekly monthly yearly"
        date next_run_on
        boolean active
        jsonb line_items
    }
    audit_logs {
        uuid id PK
        uuid org_id FK
        uuid actor_user_id
        text action
        text entity_type
        uuid entity_id
        jsonb metadata
        timestamptz created_at
    }
```

Not in the diagram: `webhook_events` (`stripe_event_id` primary key, `type`,
`processed_at`). It is global, has no tenant, and exists only for webhook
idempotency.

## Conventions

- Primary keys are UUIDs, so ids are not guessable and not enumerable.
- Every tenant-owned table has `org_id uuid not null` and an index that starts
  with `org_id`.
- `created_at` and `updated_at` on mutable tables, in UTC (`timestamptz`).
- Soft delete (`deleted_at`) for `clients` and `invoices`. Queries filter it by
  default. Hard deletes are limited to a future retention job.
- `audit_logs` is append-only: the app role gets INSERT and SELECT only.

## RLS coverage

| Table | RLS | Why |
|---|---|---|
| clients, invoices, invoice_line_items, payments, subscriptions, invoice_counters, recurring_templates, audit_logs | Yes, by `org_id` | Tenant-owned data |
| memberships | Yes, by `org_id`, plus a narrow read policy by user id | Login must list a user's organizations before any tenant is chosen |
| organizations | Yes, visible only if the user has a membership | Same reason |
| users, refresh_tokens, auth_tokens, webhook_events | No | Not tenant-owned. Protected by the application layer and column rules |

## Money rules

- All amounts are integer minor units (cents) in `bigint`. No floats.
- One currency per invoice, default USD, assumed to have 2 decimal places.
- `quantity` is `numeric(12,4)`. `tax_rate_bps` is an integer in basis points
  (825 means 8.25 percent).
- Per line: `line_total = round(quantity * unit_price)`, then
  `line_tax = round(line_total * tax_rate_bps / 10000)`, rounding half up.
- Invoice totals are the sums of the rounded line values, so the printed numbers
  always add up exactly.
- Totals are stored (not recomputed on read) so an issued invoice never changes
  if rules change later.

## Invoice numbering

- Format `INV-000001`, unique per organization, via `unique (org_id, number)`.
- The number is assigned when a draft is first sent, not on creation, so
  abandoned drafts leave no gaps.
- Assignment locks the org's `invoice_counters` row
  (`select ... for update`), increments it, and uses the value, all in one
  transaction. Concurrent sends cannot produce duplicates.

## Invoice lifecycle

`draft -> sent -> paid`, `sent -> overdue` (set by a daily job), and
`draft|sent|overdue -> void`. Once an invoice leaves `draft`, its lines, amounts
and number are immutable. Corrections are done by voiding and reissuing.
