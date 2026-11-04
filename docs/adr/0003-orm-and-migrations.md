# ADR-0003: ORM and migrations

- Status: Accepted
- Date: 2026-11-04

## Context

We need an ORM that works with NestJS and TypeScript, supports reviewed and
versioned migrations, and can run every query inside a transaction that first
sets the tenant for Postgres RLS (ADR-0001). It must also handle money without
floating point errors.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| A. Prisma | Generated types from one schema file, migrations are plain SQL files we can edit, large community | Extra abstraction, some complex SQL needs raw queries, query engine adds weight to the Docker image |
| B. TypeORM | Native NestJS integration, decorators, QueryRunner gives direct transaction control | Weaker type safety, migration generation is less reliable, historically slower maintenance |
| C. Query builder (Kysely) or Drizzle | Close to SQL, light, strong typing | Smaller NestJS ecosystem, more hand-written code |

## Decision

Prisma with SQL migrations (`prisma migrate`).

- RLS policies, `FORCE ROW LEVEL SECURITY`, roles and grants live in migration
  SQL files that are edited by hand and committed. Prisma does not model RLS in
  its schema, so the SQL files are the source of truth for it.
- Tenant context: a single service wraps tenant-scoped work in an interactive
  transaction (`$transaction`), runs `set_config('app.tenant_id', ..., true)`
  first, then runs the queries on the transaction client. Controllers and
  services never use the base client for tenant data.
- Two database roles:
  - `app_owner`: owns the tables, used only to run migrations.
  - `app_user`: used by the running API. No ownership, no `BYPASSRLS`, only the
    grants it needs.
- Money is stored as integer minor units (cents) plus a currency code, or as
  Postgres `numeric`. Never `float`. Final choice is made in the data model.
- A test helper connects as `app_user` against a real Postgres container, so
  isolation tests exercise the real RLS policies.

## Consequences

Positive:
- Strong types from the schema, readable diffs in migration files.
- RLS is reviewed like any other code, since it lives in SQL migrations.

Negative / risks:
- Raw SQL is needed for RLS and a few reports. We keep it in migrations and a
  small, tested set of repository methods.
- Using the wrong client (the base client instead of the transaction client)
  would skip the tenant setting. With `app_user` and RLS this fails closed
  (zero rows), and a lint rule and tests catch it.
- Interactive transactions hold a connection, so keep them short and never
  call external services (Stripe, email) inside them.

## Revisit when

Performance profiling shows ORM overhead matters, or schema complexity makes
the generated client a poor fit. Kysely would be the likely replacement.
