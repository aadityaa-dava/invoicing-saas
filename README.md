# Invoicing SaaS
 
A multi-tenant invoicing and subscription billing platform. Organizations manage
clients, issue invoices, and collect payments; every organization's data is
isolated from every other's at the database level.
 
The project is built phase by phase, with each phase committed, tested and
documented before the next begins. Everything runs locally and on free tiers.
 
## Status
 
| Phase | Scope | State |
|---|---|---|
| 0 | Workspace, tooling, repository skeleton | Done |
| 1 | Design document, data model, threat model, ADRs | Done |
| 2 | Local environment (Postgres, Redis, env validation, health checks) | Done |
| 3 | Authentication | Done |
| 4 | Multi-tenancy with row-level security | Done |
| 5 | Role-based access control and member management | Done |
| 6 | Invoices: line items, money arithmetic, numbering, PDF | Done |
| 7 | Background jobs (email, recurring invoices, overdue sweep) | Planned |
| 8 | Stripe in test mode (subscriptions, invoice payment, webhooks) | Planned |
| 9 | Audit log, pagination, OpenAPI | Planned |
| 10 | Web frontend (Next.js) | Planned |
| 11 | Browser tests and CI coverage gates | Planned |
| 12 | Infrastructure as code and zero-cost deployment | Planned |
| 13 | CI/CD with staging and production | Planned |
| 14 | Observability and security hardening | Planned |
| 15 | Final polish and demo | Planned |
 
## Stack
 
| Area | Choice |
|---|---|
| Language | TypeScript (strict) on Node 26 |
| API | NestJS 11 |
| Database | PostgreSQL 17, Prisma 7 with the `pg` driver adapter |
| Cache and rate limits | Redis 7 (`ioredis`) |
| Validation | zod, at every boundary including environment variables |
| PDF | pdfkit (pure JavaScript, no browser) |
| Tests | Jest 30, Supertest |
| Tooling | pnpm workspace, Docker Compose, conventional commits |
| Planned | BullMQ, Stripe (test mode), Next.js, Terraform, GitHub Actions, Playwright, Sentry |
 
## What is implemented
 
### Multi-tenancy (ADR-0001)
 
- One shared schema. Every tenant-owned row carries an `org_id`.
- PostgreSQL row-level security is enabled and **forced** on tenant tables, so
  even the table owner is subject to the policies.
- Two database roles. `app_owner` owns tables and runs migrations. `app_user`
  serves the API and has no ownership and no `BYPASSRLS`.
- Tenant context (`app.user_id`, `app.org_id`) is set per transaction with
  `set_config(..., true)`, so a pooled connection can never carry one tenant's
  context into another request. Missing context fails closed to zero rows.
- All tenant data access goes through one `TenantDb` service that opens the
  transaction and sets the context.
### Authentication (ADR-0002)
 
- Passwords hashed with argon2id.
- Short-lived JWT access tokens (15 minutes, HS256 pinned) and opaque refresh
  tokens stored only as SHA-256 hashes.
- Refresh rotation with token families and reuse detection: replaying a used
  refresh token revokes the whole family.
- Refresh cookie is `HttpOnly`, `SameSite=Strict`, path-scoped, and `Secure` in
  production, with a custom-header CSRF check on cookie-authenticated routes.
- Email verification, password reset, uniform responses that do not reveal
  whether an account exists, and a dummy-hash path to equalize timing.
- Per-IP rate limits and per-account login lockout, both backed by Redis. If
  Redis is unavailable, authentication fails closed.
- Deny-by-default: every route requires a valid token unless marked `@Public()`.
### Authorization (ADR-0004)
 
- Four roles: owner, admin, member, viewer. Controllers declare permissions
  (for example `client:write`), never role names.
- A single static permission map. Owner holds every permission; other roles are
  explicit allow-lists, so a new permission is owner-only until deliberately
  granted.
- Any route with an `:orgId` parameter is automatically membership-checked.
  Non-members, unknown organizations and malformed ids all receive the same
  `404`, so organization ids cannot be enumerated. A member lacking a
  permission receives `403`.
- The guard fails closed: an org-scoped route that declares no permission is
  refused.
- Roles are read from the database on every request, never from the token, so
  removals and role changes take effect immediately.
- Member management enforces rules a static map cannot express: admins cannot
  touch owners, only owners can grant ownership, and the last owner can never be
  demoted or removed. Owner changes run under a `SELECT ... FOR UPDATE` lock so
  concurrent changes cannot leave an organization without an owner.
### Invoices (ADR-0005)

- Drafts are created with line items and the server computes every amount in
  integer cents with per-line half-up rounding, so printed numbers always add
  up. Clients cannot submit totals.
- Numbers (`INV-000001`) are assigned when an invoice is sent, from a counter
  row locked inside the same transaction, so they are unique and gapless even
  under concurrent sends and rollbacks.
- Lifecycle: draft, sent, paid, overdue, void. Only drafts can be edited or
  deleted, and edit, send and void share one row lock so they cannot interleave.
- The database enforces the shape of the data too: check constraints on
  amounts, dates and numbers, and foreign keys that carry the organization id so
  nothing can reference another tenant's records.
- PDFs are rendered in memory, private and uncacheable. Drafts and voided
  invoices are watermarked.

### Conventions
 
- Errors use RFC 9457 `application/problem+json` with a stable `code` field.
- Liveness (`/health/live`) and readiness (`/health/ready`, which checks
  Postgres and Redis) are separate endpoints outside the `/v1` prefix.
- Soft delete for clients and invoices. Money is stored as integer cents (see
  `docs/data-model.md`).
## API (implemented so far)
 
All routes are under `/v1` unless noted. "Permission" is the permission required
within the organization.
 
| Method | Path | Permission |
|---|---|---|
| POST | `/auth/signup`, `/auth/verify-email`, `/auth/login`, `/auth/refresh`, `/auth/logout` | public |
| POST | `/auth/password/forgot`, `/auth/password/reset` | public |
| GET | `/me` | any signed-in user |
| POST | `/orgs` | any signed-in user (creator becomes owner) |
| GET | `/orgs` | any signed-in user (own organizations) |
| GET | `/orgs/:orgId` | any member |
| PATCH | `/orgs/:orgId` | `org:update` |
| GET | `/orgs/:orgId/members` | `member:read` |
| POST | `/orgs/:orgId/members` | `member:manage` |
| PATCH, DELETE | `/orgs/:orgId/members/:userId` | `member:manage` |
| POST | `/orgs/:orgId/clients` | `client:write` |
| GET | `/orgs/:orgId/clients`, `/orgs/:orgId/clients/:id` | `client:read` |
| PATCH | `/orgs/:orgId/clients/:id` | `client:write` |
| DELETE | `/orgs/:orgId/clients/:id` | `client:delete` (soft delete) |
| POST | `/orgs/:orgId/invoices` | `invoice:write` |
| GET | `/orgs/:orgId/invoices`, `/orgs/:orgId/invoices/:id` | `invoice:read` |
| PATCH, DELETE | `/orgs/:orgId/invoices/:id` | `invoice:write` (drafts only) |
| POST | `/orgs/:orgId/invoices/:id/send` | `invoice:send` |
| POST | `/orgs/:orgId/invoices/:id/void` | `invoice:void` |
| GET | `/orgs/:orgId/invoices/:id/pdf` | `invoice:read` |
| GET | `/health/live`, `/health/ready` (no `/v1` prefix) | public |
 
The full planned surface is in [`docs/api-design.md`](docs/api-design.md).
 
## Getting started
 
Prerequisites: Docker, [nvm](https://github.com/nvm-sh/nvm), and Corepack
(bundled with Node).
 
```bash
nvm use                      # picks the Node version from .nvmrc
corepack enable
pnpm install
 
cp .env.example .env         # then set the secrets, see below
pnpm infra:up                # Postgres and Redis in Docker
 
pnpm --filter api exec prisma generate
pnpm --filter api exec prisma migrate deploy
 
pnpm --filter api start:dev  # API on http://localhost:4000
```
 
Generate the token signing secret with `openssl rand -base64 48` and put it in
`JWT_ACCESS_SECRET`. Local ports default to 5433 (Postgres), 6380 (Redis) and
4000 (API) so they do not clash with services already on your machine.
 
Other infrastructure commands: `pnpm infra:down`, `pnpm infra:reset` (destroys
local data), `pnpm infra:logs`.
 
### Configuration
 
The API validates its environment at startup and refuses to boot on invalid
values.
 
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Runtime connection, as the restricted `app_user` role |
| `MIGRATION_DATABASE_URL` | Migration connection, as `app_owner` |
| `REDIS_URL` | Redis connection |
| `JWT_ACCESS_SECRET` | Access token signing secret, at least 32 characters |
| `ACCESS_TOKEN_TTL_SECONDS` | Default 900 |
| `REFRESH_TOKEN_TTL_DAYS` | Default 7 |
| `WEB_URL` | Allowed web origin, default `http://localhost:3001` |
| `PORT` | Default 4000 |
 
The Docker Compose variables (`POSTGRES_*`, `APP_OWNER_PASSWORD`,
`APP_USER_PASSWORD`, port settings) are listed in `.env.example`.
 
## Testing
 
```bash
pnpm --filter api test          # unit tests
pnpm --filter api test:e2e      # end-to-end tests, needs `pnpm infra:up`
pnpm --filter api exec tsc --noEmit
```
 
The end-to-end suite runs the real application against real Postgres and Redis
through the restricted database role, with no mocks for the data layer.
 
- Over 160 end-to-end tests cover authentication, tenancy, authorization,
  member management and the resource endpoints.
- 16 database-level tests attack row-level security directly: cross-tenant
  reads, updates, deletes and inserts, moving a row between tenants, leakage
  across pooled connections, and the owner role being subject to the policies.
- A role-by-endpoint test checks every role against every route, and unit
  tests mirror the permission matrix from the design document.
- Concurrency is tested, not assumed: one test holds the owner-row lock in a
  separate transaction to prove that owner changes wait for it.
- Security tests are checked for the ability to fail. Disabling a policy or
  removing the lock makes the matching tests go red.
## Repository layout
 
```
apps/
  api/
    prisma/            schema and migrations (RLS policies are hand-written SQL)
    src/
      auth/            signup, login, refresh, recovery, guards
      clients/         client CRUD with soft delete
      common/          problem-details filter, validation pipe
      config/          environment validation
      health/          liveness and readiness
      invoices/        invoices, money arithmetic, numbering, PDF
      mail/            mail service (logs in development)
      organizations/   organizations and members
      prisma/          database service
      rate-limit/      Redis rate limiter and guard
      rbac/            permission map, decorator, guard
      redis/           Redis provider
      tenancy/         TenantDb, membership guard
    test/              end-to-end tests and helpers
  web/                 frontend (planned)
infra/
  postgres/init/       role creation for the local database
docs/
  adr/                 architecture decision records
  api-design.md
  data-model.md
  threat-model.md
docker-compose.yml
```
 
## Documentation
 
| Document | Contents |
|---|---|
| [ADR-0001](docs/adr/0001-tenancy-model.md) | Shared schema with row-level security |
| [ADR-0002](docs/adr/0002-auth-strategy.md) | Authentication design |
| [ADR-0003](docs/adr/0003-orm-and-migrations.md) | Prisma, migrations, database roles |
| [ADR-0004](docs/adr/0004-authorization-rbac.md) | Permission model and member rules |
| [ADR-0005](docs/adr/0005-invoicing-money-and-numbering.md) | Money, invoice numbering and lifecycle |
| [Data model](docs/data-model.md) | Tables, money rules, invoice numbering, lifecycle |
| [API design](docs/api-design.md) | Endpoints and the permission matrix |
| [Threat model](docs/threat-model.md) | Assets, threats, mitigations, residual risks |
 
## Design decisions in brief
 
- **Why row-level security and not a tenant filter in every query?** A forgotten
  filter is a data leak. With forced RLS and a role that cannot bypass it, a
  forgotten filter returns nothing instead.
- **Why 404 for non-members?** A 403 confirms that an organization exists.
- **Why are roles not in the token?** A stale token must never keep access that
  has been revoked.
- **Why integer cents and per-line rounding?** Floating point drifts, and
  rounding each line first means the printed numbers always add up exactly.
- **Why assign invoice numbers at send time?** Abandoned drafts leave no gaps
  in the sequence.
## Known limitations
 
- Access tokens stay valid for up to 15 minutes after logout or a password
  reset. Organization access is unaffected, because membership is checked live.
- Members can only be added if they already have a verified account; there is
  no emailed invitation flow yet. As a consequence, an owner or admin can learn
  whether an address is registered.
- Behind a proxy, Express `trust proxy` must be configured at deployment so
  rate limiting sees client addresses.
- In development, emails are written to the log instead of being sent.
- The client and invoice lists are capped at 100 rows until pagination arrives in Phase 9.
- Invoice immutability after sending is enforced by the application. A database trigger as a second layer is planned for the hardening phase.
- Only two-decimal currencies are supported (USD, EUR, GBP, CAD, AUD).
 
