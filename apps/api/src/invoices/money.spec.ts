import {
  computeLine,
  computeTotals,
  MAX_LINE_AMOUNT_CENTS,
  MAX_LINES,
  MoneyError,
  parseQuantity,
} from './money';

const line = (quantity: string, unitPriceCents: bigint, taxRateBps = 0) =>
  computeLine({ quantity, unitPriceCents, taxRateBps });

describe('parseQuantity', () => {
  it.each([
    ['1', 10_000n],
    ['1.5', 15_000n],
    ['0.0001', 1n],
    ['12.3456', 123_456n],
    ['99999999.9999', 999_999_999_999n],
  ])('parses %s', (input, expected) => {
    expect(parseQuantity(input)).toBe(expected);
  });

  it.each(['', 'abc', '-1', '0', '0.0000', '1.23456', '1,5', ' 1', '1e3', '.5'])(
    'rejects %j',
    (input) => {
      expect(() => parseQuantity(input)).toThrow(MoneyError);
    },
  );
});

describe('computeLine', () => {
  it('multiplies whole quantities exactly', () => {
    expect(line('3', 333n)).toEqual({ lineTotalCents: 999n, lineTaxCents: 0n });
  });

  it('rounds the line total half up', () => {
    expect(line('0.5', 1001n).lineTotalCents).toBe(501n); // 500.5 -> 501
    expect(line('0.5', 1000n).lineTotalCents).toBe(500n); // exact
    expect(line('1.2345', 100n).lineTotalCents).toBe(123n); // 123.45 -> 123
    expect(line('1.2355', 100n).lineTotalCents).toBe(124n); // 123.55 -> 124
  });

  it('rounds tax half up', () => {
    // 8.25% of 10.00 = 0.825 -> 83 cents
    expect(line('1', 1000n, 825).lineTaxCents).toBe(83n);
    // 8.25% of 9.99 = 0.824175 -> 82
    expect(line('1', 999n, 825).lineTaxCents).toBe(82n);
  });

  it('handles zero price, zero tax and full tax', () => {
    expect(line('5', 0n, 825)).toEqual({ lineTotalCents: 0n, lineTaxCents: 0n });
    expect(line('2', 500n, 0).lineTaxCents).toBe(0n);
    expect(line('1', 1234n, 10_000).lineTaxCents).toBe(1234n);
  });

  it('is exact where floating point is not', () => {
    // 0.1 + 0.2 style trap: 3 x 0.1 must be exactly 0.3 -> 30 cents of 100
    expect(line('3', 10n).lineTotalCents).toBe(30n);
    expect(line('1.1', 10n).lineTotalCents).toBe(11n);
  });

  it.each([-1n])('rejects a negative unit price', (price) => {
    expect(() => line('1', price)).toThrow(MoneyError);
  });

  it.each([-1, 10_001, 8.25, Number.NaN])('rejects tax rate %s', (bps) => {
    expect(() => line('1', 100n, bps)).toThrow(MoneyError);
  });

  it('rejects amounts above the per-line cap', () => {
    expect(() => line('1', MAX_LINE_AMOUNT_CENTS + 1n)).toThrow('amount_too_large');
    expect(line('1', MAX_LINE_AMOUNT_CENTS).lineTotalCents).toBe(
      MAX_LINE_AMOUNT_CENTS,
    );
  });
});

describe('computeTotals', () => {
  it('sums rounded lines so the printed numbers add up', () => {
    const lines = [line('1', 333n, 825), line('1', 333n, 825), line('1', 333n, 825)];
    // each tax: 333 * 825 / 10000 = 27.47 -> 27
    expect(computeTotals(lines)).toEqual({
      subtotalCents: 999n,
      taxCents: 81n,
      totalCents: 1080n,
    });
    // Taxing the 999 total once would give 82: this is why the rule is per line.
    expect(line('1', 999n, 825).lineTaxCents).toBe(82n);
  });

  it('handles an empty invoice', () => {
    expect(computeTotals([])).toEqual({
      subtotalCents: 0n,
      taxCents: 0n,
      totalCents: 0n,
    });
  });

  it('always satisfies total = subtotal + tax = sum of lines', () => {
    let seed = 42;
    const rand = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    for (let i = 0; i < 300; i++) {
      const lines = Array.from({ length: 1 + rand(10) }, () =>
        line(
          `${1 + rand(50)}.${String(rand(10_000)).padStart(4, '0')}`,
          BigInt(rand(1_000_000)),
          rand(2_501),
        ),
      );
      const t = computeTotals(lines);
      const sum = lines.reduce(
        (acc, l) => acc + l.lineTotalCents + l.lineTaxCents,
        0n,
      );
      expect(t.totalCents).toBe(t.subtotalCents + t.taxCents);
      expect(t.totalCents).toBe(sum);
    }
  });

  it('stays within safe JSON integers at the maximum', () => {
    const max = line('1', MAX_LINE_AMOUNT_CENTS, 10_000);
    const lines = Array.from({ length: MAX_LINES }, () => max);
    const t = computeTotals(lines);
    expect(t.totalCents <= BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('rejects more than the maximum number of lines', () => {
    const lines = Array.from({ length: MAX_LINES + 1 }, () => line('1', 1n));
    expect(() => computeTotals(lines)).toThrow('too_many_lines');
  });
});
