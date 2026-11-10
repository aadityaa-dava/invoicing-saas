# ADR-0005: Money, invoice numbering and lifecycle

- Status: Accepted
- Date: 2026-11-10

## Context

Invoices are legal and financial documents. Three properties matter more than
speed: amounts must be exact, numbers must be unique and without gaps, and an
issued invoice must not change. All of this must hold under concurrent
requests and inside a multi-tenant database (ADR-0001).

## Options considered

Money representation:

| Option | Pros | Cons |
|---|---|---|
| A. Floating point | Trivial | Rounding drift (0.1 + 0.2), unacceptable for money |
| B. Decimal library in the application | Exact | New dependency, values still need a lossless storage format |
| C. Integer minor units (cents) in `bigint` | Exact, native in Postgres, trivial to sum | Needs explicit rounding rules and a 2-decimal assumption |

Invoice numbering:

| Option | Pros | Cons |
|---|---|---|
| A. A Postgres sequence per organization | Fast, no row lock | Gaps after a rollback, DDL for every new organization |
| B. A counter row locked inside the sending transaction | Gapless, atomic with the invoice update, no DDL | Sends within one organization are serialized |
| C. `SELECT max(number) + 1` | No extra table | Races unless locked, slow as data grows |

PDF generation:

| Option | Pros | Cons |
|---|---|---|
| A. Headless browser (HTML to PDF) | Familiar layout tools | Heavy, high memory, slow cold start, awkward on free hosting |
| B. Hosted PDF service | No code | Cost, and customer data leaves our systems |
| C. `pdfkit` (pure JavaScript) | Free, fast, no native binaries | Layout is written in code |

## Decision

Money (C):
- Every amount is an integer number of cents. Quantities are decimal strings
  with at most four decimals, tax rates are integer basis points.
- Per line: `line_total = round(quantity * unit_price)`, then
  `line_tax = round(line_total * rate / 10000)`, rounding half up using
  integer arithmetic only. Invoice totals are the sums of the rounded lines,
  so printed numbers always add up. Totals are stored, never recomputed.
- The server computes every amount. A client cannot submit totals, and the
  request schema rejects unknown fields.
- Caps keep every value within 2^53, so the API returns plain JSON integers
  with no precision loss, and far below the `bigint` limit.
- Only two-decimal currencies are accepted (USD, EUR, GBP, CAD, AUD).

Numbering (B):
- A number is assigned when a draft is sent, never at creation, so abandoned
  drafts leave no gaps. Format `INV-000001`, unique per organization.
- Sending locks the invoice row, then upserts the organization's counter in
  a single statement (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`). The
  counter increment commits or rolls back together with the invoice update,
  which is what makes the sequence gapless rather than merely unique.
- Locks are always taken in the same order (invoice, then counter), and sends
  share only the counter row, so they cannot deadlock each other.

Lifecycle and immutability:
- `draft -> sent -> paid`, `sent -> overdue`, and `draft | sent | overdue ->
  void`. Only drafts can be edited or deleted (deletion is a soft delete).
  Edit, send and void all take the same row lock, so they cannot interleave:
  an edit that races a send waits, then is refused.
- The database refuses impossible rows regardless of the application: amount
  and date constraints, number format, a number required once a draft is sent,
  and foreign keys that carry the organization id so a record can never
  reference another tenant's data.

PDF (C):
- `pdfkit` renders the document in memory. Drafts and voided invoices are
  watermarked, and a draft shows no number. The response is private and is
  not cacheable.

## Consequences

Positive:
- Exact money with a short, testable rule set, and numbering that is
  provably unique and gapless, including under concurrent sends and rollback.
- No cost and no external service for PDFs.

Negative / risks:
- Sends within one organization queue on the counter row. Acceptable at this
  scale, and a deliberate price for gapless numbers.
- A rounded-per-line total can differ by a cent from rounding the grand total
  once. This is intentional and documented, because the printed lines must add up.
- Immutability after sending is enforced by the application. A database trigger
  as a second layer is planned (see the threat model).
- A single currency per invoice and no zero-decimal currencies yet.

## Revisit when

A jurisdiction requires a different numbering format or per-series counters,
zero-decimal currencies are needed, or send volume per organization makes the
counter lock a bottleneck.
