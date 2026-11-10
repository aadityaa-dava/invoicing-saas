import { formatMoney } from './format-money';

describe('formatMoney', () => {
  it.each([
    [0n, '$0.00'],
    [5n, '$0.05'],
    [100n, '$1.00'],
    [1999n, '$19.99'],
    [123_456n, '$1,234.56'],
    [100_000_000n, '$1,000,000.00'],
    [10n ** 15n, '$10,000,000,000,000.00'],
    [-1234n, '-$12.34'],
  ])('formats %s cents as %s', (cents, expected) => {
    expect(formatMoney(cents, 'USD')).toBe(expected);
  });

  it('uses the right symbol per currency', () => {
    expect(formatMoney(1050n, 'EUR')).toBe('€10.50');
    expect(formatMoney(1050n, 'GBP')).toBe('£10.50');
    expect(formatMoney(1050n, 'CAD')).toBe('CA$10.50');
    expect(formatMoney(1050n, 'AUD')).toBe('A$10.50');
  });

  it('falls back to the currency code for an unknown currency', () => {
    expect(formatMoney(100n, 'XYZ')).toBe('XYZ 1.00');
  });
});
