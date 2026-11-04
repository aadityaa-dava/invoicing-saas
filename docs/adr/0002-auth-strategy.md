# ADR-0002: Authentication and session strategy

- Status: Accepted
- Date: 2026-11-04

## Context

Users sign up with email and password, verify their email, and may belong to
several organizations (tenants) with a different role in each. We need
short-lived API credentials, revocable sessions, and brute-force protection.
Budget is $0 and the project must demonstrate auth end to end.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| A. Hosted provider (Auth0, Clerk, Supabase Auth) | Less code, MFA and social login for free | Free-tier limits, vendor lock-in, hides the skills this project should show |
| B. Self-built: JWT access token + rotating refresh token | Full control, no vendor, demonstrates the fundamentals | We own the security bugs |
| C. Server-side sessions in Redis (opaque session id cookie) | Instant revocation, simple mental model | Needs a Redis lookup on every request |

## Decision

Option B, built carefully:

- Passwords hashed with argon2id (memory-hard, current OWASP recommendation).
  Never log or return password hashes.
- Access token: JWT, 15-minute lifetime, signed with a secret from the
  environment, containing only the user id and token id (`sub`, `jti`). It does
  not contain roles or tenant, because those can change during its lifetime.
- Refresh token: random 256-bit opaque value, 7-day lifetime, delivered in an
  HttpOnly, Secure, SameSite cookie. Only its SHA-256 hash is stored in
  Postgres.
- Rotation with reuse detection: each refresh issues a new refresh token and
  invalidates the old one. If an already-used token is presented, the whole
  token family is revoked (it was probably stolen).
- Email verification: single-use random token, stored hashed, expires in 24
  hours. Unverified users cannot create or join organizations.
- Rate limiting: Redis-backed limiter on login, signup and password reset,
  keyed by IP and by account, to slow credential stuffing.
- Login errors are generic ("invalid credentials") to avoid account
  enumeration. Password reset responses are identical whether or not the
  email exists.

## Tenant and role resolution

The JWT identifies the user only. The active organization comes from the route
(`/orgs/:orgId/...`), and a guard looks up the user's membership and role for
that organization on every request. This keeps roles instantly revocable and
means a token can never carry stale permissions. The verified organization id
then feeds the Postgres RLS setting from ADR-0001.

## Consequences

Positive:
- No vendor lock-in and no cost.
- Role changes and membership removal take effect immediately.
- Stolen refresh tokens are detected through reuse detection.

Negative / risks:
- We are responsible for getting the crypto and token handling right. Mitigated
  by using vetted libraries (argon2, jose or Nest's JWT module) and writing
  tests for expiry, rotation, reuse and tampering.
- A membership lookup on every request. Cheap with an index, and cacheable
  later if needed.
- Cookie handling across origins: if the web app and API are on different
  sites, SameSite rules apply. We will proxy API calls through the Next.js
  origin so cookies stay first-party.
- No MFA or social login at launch. Listed as a known limitation.

## Revisit when

We need SSO, SAML or MFA for customers. At that point we would adopt a
provider rather than build these ourselves.
