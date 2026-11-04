# API design

REST over JSON, versioned under `/v1`. OpenAPI docs are generated from the code
(`@nestjs/swagger`) and served at `/docs`.

## Conventions

- Tenant-scoped resources live under `/v1/orgs/:orgId/...`. The org id in the
  path is checked against the caller's membership on every request
  (ADR-0002), then fed to RLS (ADR-0001).
- Fields are camelCase. Ids are UUIDs. Timestamps are ISO 8601 UTC. Money is
  returned as integer cents plus a `currency` code.
- Errors use RFC 9457 `application/problem+json` with a stable machine-readable
  `code`, for example `invoice_not_editable`. Validation errors list the failing
  fields.
- Lists use cursor pagination: `?limit=25&cursor=...`, responding with
  `{ "data": [...], "nextCursor": "..." | null }`. Default limit 25, max 100.
  Cursors beat offsets because they stay correct and fast as data changes.
- Filtering by query parameter, for example
  `?status=sent&clientId=...&from=2026-01-01&to=2026-03-31`. Sorting with
  `?sort=-issueDate`.
- Another tenant's resource returns `404`, not `403`, so ids cannot be probed.
- Unsafe actions that must not repeat (send invoice, create checkout session)
  accept an `Idempotency-Key` header.
- Rate limits return `429` with `Retry-After`. Limits are strictest on auth
  routes.

## Endpoints

### Auth and identity
| Method | Path | Notes |
|---|---|---|
| POST | /v1/auth/signup | Creates user, sends verification email |
| POST | /v1/auth/verify-email | Consumes the emailed token |
| POST | /v1/auth/resend-verification | Always responds the same |
| POST | /v1/auth/login | Returns access token, sets refresh cookie |
| POST | /v1/auth/refresh | Rotates the refresh token |
| POST | /v1/auth/logout | Revokes the token family |
| POST | /v1/auth/password/forgot | Always responds the same |
| POST | /v1/auth/password/reset | Consumes the emailed token |
| GET | /v1/me | Current user and their organizations with roles |

### Organizations and members
| Method | Path | Notes |
|---|---|---|
| POST | /v1/orgs | Creator becomes owner |
| GET | /v1/orgs/:orgId | |
| PATCH | /v1/orgs/:orgId | Name and settings |
| GET | /v1/orgs/:orgId/members | |
| POST | /v1/orgs/:orgId/members | Adds an existing verified user by email |
| PATCH | /v1/orgs/:orgId/members/:userId | Change role |
| DELETE | /v1/orgs/:orgId/members/:userId | Remove member |

### Clients, invoices, recurring
| Method | Path | Notes |
|---|---|---|
| GET, POST | /v1/orgs/:orgId/clients | |
| GET, PATCH, DELETE | /v1/orgs/:orgId/clients/:id | DELETE is a soft delete |
| GET, POST | /v1/orgs/:orgId/invoices | Filter, sort, paginate |
| GET, PATCH, DELETE | /v1/orgs/:orgId/invoices/:id | PATCH and DELETE only while `draft` |
| POST | /v1/orgs/:orgId/invoices/:id/send | Assigns number, queues email |
| POST | /v1/orgs/:orgId/invoices/:id/void | |
| GET | /v1/orgs/:orgId/invoices/:id/pdf | Streams the PDF |
| POST | /v1/orgs/:orgId/invoices/:id/payment-link | Creates a Stripe payment link |
| GET, POST | /v1/orgs/:orgId/recurring | |
| GET, PATCH, DELETE | /v1/orgs/:orgId/recurring/:id | |

### Billing, audit, platform
| Method | Path | Notes |
|---|---|---|
| GET | /v1/orgs/:orgId/billing | Current plan and status |
| POST | /v1/orgs/:orgId/billing/checkout-session | Stripe Checkout for the plan |
| POST | /v1/orgs/:orgId/billing/portal-session | Stripe customer portal |
| GET | /v1/orgs/:orgId/audit-logs | Filter by actor, entity, date |
| POST | /v1/webhooks/stripe | Public. Raw body, signature verified, idempotent |
| GET | /health/live, /health/ready | Liveness, and readiness (database, Redis) |

## Permission matrix

| Action | owner | admin | member | viewer |
|---|---|---|---|---|
| View clients, invoices, PDFs | yes | yes | yes | yes |
| Create and edit clients, create and edit draft invoices | yes | yes | yes | no |
| Send invoices, create payment links | yes | yes | yes | no |
| Void invoices, delete clients | yes | yes | no | no |
| Manage recurring templates | yes | yes | yes | no |
| Manage members (cannot touch owners unless owner) | yes | yes | no | no |
| View audit log | yes | yes | no | no |
| Manage billing and subscription | yes | no | no | no |
| Edit org settings | yes | yes | no | no |

Authorization is expressed as permissions (for example `invoice:send`) mapped
from roles in one place, so controllers declare the permission they need and
never check role names directly.

## Known v1 limits

- Members are added by email only if the user already has a verified account.
  There is no emailed invitation flow for people without an account yet.
- Single currency per invoice, 2-decimal currencies only.
