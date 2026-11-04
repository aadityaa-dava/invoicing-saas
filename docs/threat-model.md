# Threat model

Scope: the invoicing API, web app, database, queue and third-party integrations.
Method: STRIDE-style review of each trust boundary. Reviewed again in Phase 14
against the OWASP Top 10.

## Assets

- Tenant financial data and client personal data (names, emails, addresses).
- User credentials, refresh tokens and session integrity.
- Stripe keys, the webhook secret, and the integrity of payment state.
- Availability of the service.

## Actors

Anonymous internet user, authenticated member of tenant A probing tenant B, a
low-privilege user seeking more rights, an attacker holding a stolen token, and
a developer or dependency that leaks secrets.

## Trust boundaries

Browser to web app, web app to API, API to Postgres and Redis, API to Stripe,
Stripe to our webhook endpoint, API to the email provider, CI/CD to hosting.

## Threats and mitigations

| ID | Threat | Mitigation | Verified by |
|---|---|---|---|
| T1 | Cross-tenant read or write (missing filter, guessed id) | Postgres RLS with FORCE, non-owner app role, set per transaction (ADR-0001). Cross-tenant ids return 404 | Isolation tests, Phase 4 |
| T2 | Privilege escalation within a tenant | Deny-by-default permission guards, role to permission map in one place | Per-role tests, Phase 5 |
| T3 | Tampered token or org claim | JWT holds only the user id, algorithm pinned, signature and expiry checked, membership looked up on every request | Auth tests, Phase 3 |
| T4 | Brute force and credential stuffing | argon2id, Redis rate limits per IP and per account, generic login errors | Rate limit tests, Phase 3 |
| T5 | Account enumeration | Identical responses for signup resend, forgot password and failed login | Auth tests, Phase 3 |
| T6 | Stolen refresh token | Rotation, reuse detection revokes the family, tokens stored hashed, HttpOnly cookie | Token tests, Phase 3 |
| T7 | XSS stealing credentials | Access token kept in memory only, CSP and security headers, React output escaping | Review, Phase 14 |
| T8 | CSRF on cookie-authenticated routes | SameSite cookie, refresh route requires a custom header and origin check, all other routes use a bearer header | E2E test, Phase 11 |
| T9 | Forged Stripe webhook | Signature verification on the raw body, timestamp tolerance, secret from env | Webhook tests, Phase 8 |
| T10 | Replayed or duplicate webhook or job | `webhook_events` table with unique event id, idempotency keys on jobs | Webhook and job tests, Phases 7 and 8 |
| T11 | Client marks an invoice paid or changes amounts | Paid status set only from a verified webhook, amounts always read from the database | Payment tests, Phase 8 |
| T12 | Edits to an issued invoice | Immutability enforced in the service layer, changes recorded in the audit log | Domain tests, Phase 6 |
| T13 | SQL injection | Parameterized queries only, raw SQL via tagged templates, no string concatenation | Code review, lint, Phase 14 |
| T14 | Unsafe PDF rendering (injected HTML, remote fetches) | Render from fixed templates with escaped fields, renderer cannot make network requests | PDF tests, Phase 6 |
| T15 | Secrets in git or logs | `.env` ignored, secret scanning in CI, log redaction of auth headers and tokens | CI check, Phase 14 |
| T16 | Vulnerable or malicious dependency | Lockfile, `pnpm audit` and Dependabot in CI, pinned base image versions | CI, Phase 14 |
| T17 | Resource exhaustion | Rate limits, pagination caps, request body size limits, bounded job concurrency with backoff | Load check, Phase 14 |
| T18 | Tampering with the audit log | App role has INSERT and SELECT only on `audit_logs` | Permission test, Phase 9 |
| T19 | Abuse of email sending | Verified email required, per-organization send limits | Job tests, Phase 7 |
| T20 | Mass assignment | DTO validation with whitelist and `forbidNonWhitelisted` | Validation tests, Phase 3 onward |

## Residual risks and out of scope

- No MFA at launch.
- Free-tier infrastructure: no WAF, limited backups, no formal pen test.
- A compromised database host or cloud account is outside this model.
- No DDoS protection beyond what the hosting provider includes.
