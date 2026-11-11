# ADR-0006: Background jobs and cross-tenant scheduling

- Status: Accepted
- Date: 2026-11-11

## Context

Three things must happen outside a request: delivering email, marking sent
invoices overdue once their due date has passed, and generating invoices from
recurring templates. The last two must find work across every organization,
but the application database role is deliberately blind across tenants
(ADR-0001) and never bypasses row-level security. The jobs also run on a
schedule, may run on more than one instance, and may be retried, so each one
must be safe to run twice.

## Options considered

Job runtime:

| Option | Pros | Cons |
|---|---|---|
| A. In-process timers | No new infrastructure | Lost on restart, duplicated on every instance, no retries or backoff |
| B. A Postgres-backed queue | No Redis dependency | More load on the primary database, less tooling for schedules and retries |
| C. BullMQ on Redis | Retries, backoff, concurrency limits and repeatable schedules built in, Redis is already present | Redis availability and command quotas matter, delivery is at least once |

Cross-tenant discovery:

| Option | Pros | Cons |
|---|---|---|
| A. A worker role with `BYPASSRLS` | Simple | One bug exposes every tenant, and it breaks the rule that the application never bypasses row-level security |
| B. Narrow `SECURITY DEFINER` functions that return organization ids only | Smallest possible blast radius, reviewed in migrations, testable | Needs an owner-scoped policy, one function per question |
| C. List organizations, then switch context per organization | Uses existing code paths | The `organizations` table is only readable per tenant or membership, so there is nothing to list |

## Decision

Runtime (C). BullMQ on the existing Redis, in two queues so a burst of email
can never delay billing jobs: `email` and `jobs`. Redis keys are namespaced by
`QUEUE_PREFIX`, which lets each test suite use its own queue. `RUN_WORKERS`
decides whether a process consumes jobs and registers schedules, so an
API-only instance is possible.

Discovery (B). `app_orgs_with_overdue_invoices(as_of)` and
`app_orgs_with_due_recurring(as_of)` return organization ids and nothing
else. Because row-level security is forced even for the table owner, each is
paired with one read-only policy scoped to `app_owner`, a role that only runs
migrations and never connects at runtime. Hardening: `search_path` is pinned,
`EXECUTE` is revoked from `PUBLIC` and granted only to `app_user`, and the
date is a parameter so behaviour is deterministic. All actual work then runs
per organization under that organization's normal row-level security, with an
organization context and no user (`TenantContext.userId` is optional).

Fan-out. A daily sweep (02:15 and 02:30 UTC) runs discovery, fixes the date
once, and enqueues one small job per organization. A slow or failing
organization never blocks the others and a retry is scoped to one
organization. The job id is deterministic (`<job>-<orgId>-<date>`), so a
repeated sweep is deduplicated by the queue, and the work is idempotent
anyway. Schedules are registered with fixed ids, so restarts update them in
place.

Overdue. `sent` invoices whose due date is before the run date become
`overdue`. The update matches on status and date, so a repeat changes nothing,
and it takes the same row locks as send and void.

Recurring generation, idempotent in three independent layers:
1. The template row is locked (`FOR UPDATE SKIP LOCKED`) and advanced in the
   same transaction as the invoice insert. A template that is being edited is
   skipped until the next tick instead of making a background job wait.
2. If an invoice already exists for the run date, none is created and the
   schedule still moves forward.
3. A unique constraint on `(recurring_template_id, recurring_run_on)` is the
   final backstop.

Schedule rules. Run dates are computed from the anchor, never from the
previous run, and clamped to the month length, so a template anchored on
January 31 produces February 28 and then March 31. Arithmetic uses UTC
calendar days only. Frequency, start date and client cannot change after
creation. A start date in the past is rejected, so a back-dated template
cannot mass-mail old invoices. Missed runs are caught up, dated for their own
run date, up to 12 per template per tick. A paused template that resumes, or
an ended template that is revived, skips the runs it missed instead of
generating them in a burst.

Auto-send. When a template asks for it, each generated invoice is sent after
generation has committed, through the normal send path, so numbering,
locking and the email behave exactly as for a manual send. It is best effort:
if it fails, the invoice stays a visible draft.

Mail. Mail is queued rather than sent inline, so SMTP latency never reaches
the caller and a failed send is retried (5 attempts, exponential backoff from
5 seconds). Invoice emails carry ids only: the worker loads the invoice under
row-level security, renders the PDF, and takes the recipient from the
database, never from the job. The enqueue happens after the send
transaction commits, so a worker can never see an uncommitted or rolled-back
send. Jobs that carry a one-time token (verification, password reset) are
removed on completion and kept for 24 hours only if they fail.

Retries and failures. Sweeps and per-organization jobs retry 3 times with
exponential backoff from 30 seconds. Failed jobs are kept for 7 days as the
dead-letter record, and a job that gives up logs at error level with its
organization and date.

## Consequences

- Delivery is at least once. If SMTP accepts a message but the worker dies
  before acknowledging it, a retry sends a duplicate.
- A crash between the send commit and the enqueue loses that one email. A
  transactional outbox would close this window and is the planned hardening.
- A template whose client was deleted generates nothing and its schedule does
  not move, so nothing is lost if the client is restored. It is logged.
- The link from an invoice to its template is a single-column foreign key,
  not a composite one with `org_id`, because Prisma cannot express a
  composite relation with a nullable member. Only the generation job sets it,
  from a template it has just read under the same organization context.
- A backlog larger than the per-tick cap takes several days to clear.
- Dates are UTC days. There is no per-organization time zone.
- Each worker polls Redis continuously. Free hosted Redis tiers cap commands,
  so the deployment choice in Phase 12 has to account for that.
- The discovery functions are part of the security boundary. Any schema
  change that touches the tables they read must be reviewed with them.
