// Pure money math. Integer minor units (cents) in bigint; no floating point.
// Rules come from docs/data-model.md ("Money rules").

export class MoneyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MoneyError';
  }
}

const QTY_SCALE = 10_000n; // quantity has up to 4 decimal places
const BPS_SCALE = 10_000n; // 10000 bps = 100 percent

// A single line may not exceed $100 billion. With at most MAX_LINES lines,
// every invoice total stays below Number.MAX_SAFE_INTEGER, so the API can
// return plain JSON integers, and far below the Postgres bigint limit.
export const MAX_LINE_AMOUNT_CENTS = 10n ** 13n;
export const MAX_LINES = 200;

export interface LineInput {
  quantity: string; // decimal string, > 0, at most 4 decimals
  unitPriceCents: bigint; // >= 0
  taxRateBps: number; // integer 0..10000
}

export interface LineAmounts {
  lineTotalCents: bigint;
  lineTaxCents: bigint;
}

export interface Totals {
  subtotalCents: bigint;
  taxCents: bigint;
  totalCents: bigint;
}

// Round half up for non-negative n and positive d, using integers only.
function roundDiv(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

// "1.5" -> 15000n (quantity scaled by 10^4).
export function parseQuantity(quantity: string): bigint {
  const match = /^(\d{1,8})(?:\.(\d{1,4}))?$/.exec(quantity);
  if (!match) throw new MoneyError('invalid_quantity');
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(4, '0') || '0');
  const scaled = whole * QTY_SCALE + fraction;
  if (scaled === 0n) throw new MoneyError('invalid_quantity');
  return scaled;
}

export function computeLine(input: LineInput): LineAmounts {
  if (input.unitPriceCents < 0n) throw new MoneyError('invalid_unit_price');
  if (
    !Number.isInteger(input.taxRateBps) ||
    input.taxRateBps < 0 ||
    input.taxRateBps > 10_000
  ) {
    throw new MoneyError('invalid_tax_rate');
  }

  const qty = parseQuantity(input.quantity);
  const lineTotalCents = roundDiv(qty * input.unitPriceCents, QTY_SCALE);
  const lineTaxCents = roundDiv(
    lineTotalCents * BigInt(input.taxRateBps),
    BPS_SCALE,
  );

  if (
    lineTotalCents > MAX_LINE_AMOUNT_CENTS ||
    lineTaxCents > MAX_LINE_AMOUNT_CENTS
  ) {
    throw new MoneyError('amount_too_large');
  }
  return { lineTotalCents, lineTaxCents };
}

// Totals are sums of the already-rounded line values, so the printed
// numbers always add up exactly.
export function computeTotals(lines: readonly LineAmounts[]): Totals {
  if (lines.length > MAX_LINES) throw new MoneyError('too_many_lines');
  let subtotalCents = 0n;
  let taxCents = 0n;
  for (const line of lines) {
    subtotalCents += line.lineTotalCents;
    taxCents += line.lineTaxCents;
  }
  const totalCents = subtotalCents + taxCents;
  if (totalCents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError('amount_too_large');
  }
  return { subtotalCents, taxCents, totalCents };
}
