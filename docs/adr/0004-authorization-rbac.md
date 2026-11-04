# ADR-0004: Authorization (RBAC)

- Status: Accepted
- Date: 2026-11-04

## Context

Tenant isolation (ADR-0001) decides WHICH organization's data a request can
reach. Authorization decides WHAT a user may do inside it. Roles are owner,
admin, member and viewer, with the matrix in `docs/api-design.md`. We need
checks that are easy to review, hard to forget, and cannot be bypassed by a
stale token.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| A. Static role-to-permission map in code | Reviewed in pull requests, zero queries per check, trivial to test exhaustively | Roles cannot be customized per organization without a deploy |
| B. Roles and permissions stored in the database | Custom roles per organization | More tables, caching and invalidation, harder to audit, not needed for four fixed roles |
| C. Policy engine (CASL, OPA) | Expressive, attribute-based rules | New dependency and concepts for a small rule set |
| D. Role checks inside RLS policies only | Enforced even for buggy queries | Policies become hard to read and test, and error messages are lost (a denied write is just zero rows) |

## Decision

Option A, with the database (RLS) remaining the tenant boundary.

- A single map (`rbac/permissions.ts`) grants permissions such as
  `invoice:send` to roles. Owner holds every permission. Admin, member and
  viewer are explicit allow-lists, so a permission added later is owner-only
  until someone deliberately grants it.
- Controllers declare `@RequirePermission('...')`, never a role name. A test
  mirrors the matrix in the design doc, and the type system forces a decision
  for every new permission.
- Two global guards run on any route with an `:orgId` parameter:
  1. `OrgMembershipGuard` looks up the caller's membership. A non-member, an
     unknown organization and a malformed id all produce the same 404, so
     organization ids cannot be probed.
  2. `PermissionsGuard` compares the role with the declared permission and
     returns 403 when it is missing. It FAILS CLOSED: an org-scoped route
     that declares neither `@RequirePermission` nor `@AnyMember`, or one
     reached without a resolved membership, is refused.
- The role is read from the database on every request and is never put in the
  JWT. Removing a member or changing a role therefore takes effect on the
  next request, even while the user's access token is still valid.
- Rules that depend on the target of a request live in the service, not the
  map: admins cannot modify owners, only an owner can grant ownership, and
  the last owner can never be demoted or removed. Owner changes first lock
  the organization's owner rows with `SELECT ... FOR UPDATE`, so two
  concurrent changes cannot both pass the "another owner exists" check.

## Consequences

Positive:
- The whole permission model fits on one screen and is exhaustively tested
  for every role against every endpoint.
- Forgetting a decorator produces a visible 403 in testing, not a silent hole.
- Org-scoped authorization is not weakened by the 15 minute access token
  lifetime, because membership and role are checked live.

Negative / risks:
- Each org-scoped request runs one extra short query for the membership
  lookup, in its own transaction.
- Custom roles need a new design (Option B) and a data migration.
- Between the guard check and the service transaction there is a window of a
  few milliseconds in which an actor who was just demoted still acts with the
  role they were authorized with. The owner invariant holds regardless.

## Revisit when

Customers need custom roles, or attribute-based rules appear (for example
"members may edit only their own invoices"). A policy engine would then be
worth its cost.
