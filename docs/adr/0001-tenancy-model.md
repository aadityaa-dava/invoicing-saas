# ADR-0001: Multi-tenancy model

- Status: Accepted
- Date: 2026-11-04

## Context

The product serves many organizations (tenants). Each tenant's invoices, clients
and members must be invisible to every other tenant. A cross-tenant leak is the
single worst bug this system can have, so isolation must not depend on every
developer remembering a `WHERE` clause.

Constraints: $0 hosting budget, one developer, a managed free-tier Postgres is
likely in production, and the design must be defensible in interviews.

## Options considered

| Option | Isolation | Migrations | Ops cost | Scales to many tenants |
|---|---|---|---|---|
| A. Database per tenant | Strongest | N migrations, N connections | High | Poor |
| B. Schema per tenant | Strong | Run per schema, drift risk | Medium | Poor beyond ~1000s of schemas |
| C. Shared schema + `tenant_id` + Postgres RLS | Strong, enforced by the database | One migration | Low | Good |
| D. Shared schema + `tenant_id`, app-level filtering only | Weak, one missed filter leaks data | One migration | Low | Good |

## Decision

Option C: a single shared schema. Every tenant-owned table has a non-null
`tenant_id`, and Postgres Row-Level Security policies restrict every query to
the current tenant.

## How it works

1. Each request resolves the tenant from the authenticated user's membership.
2. Inside a transaction, the API runs `SELECT set_config('app.org_id', $1, true)`
   (the `true` makes it transaction-local, the equivalent of `SET LOCAL`).
3. Policies compare `tenant_id = current_setting('app.org_id')::uuid`.
4. The API connects as a dedicated, non-owner role with no `BYPASSRLS`.
   Table owners and superusers skip RLS by default, so we also use
   `ALTER TABLE ... FORCE ROW LEVEL SECURITY`. Migrations run as a separate
   owner role.
5. If no tenant is set, `current_setting(..., true)` returns NULL and the policy
   matches zero rows (fail closed).

## Consequences

Positive:
- Isolation is enforced by the database, so an application bug cannot leak rows.
- One schema and one migration path. Cheap to run on a free-tier database.
- Easy to prove with automated tests (tenant A must never read tenant B).

Negative / risks:
- Every query must run inside a transaction that sets the tenant. Forgetting
  this returns no rows (safe), but it is a footgun we mitigate with a single
  request-scoped wrapper.
- Connection pooling: only transaction-local settings are safe. Session-level
  `SET` can leak between requests on a pooled connection.
- A noisy tenant can affect others (shared resources). Acceptable at this scale.
- Per-tenant backup/restore or data residency is harder than with option A.
- RLS adds small planning overhead. Every `tenant_id` column needs an index,
  usually as the leading column of composite indexes.

## Revisit when

A customer requires contractual physical isolation or data residency. We would
then offer option A for that tier only.
