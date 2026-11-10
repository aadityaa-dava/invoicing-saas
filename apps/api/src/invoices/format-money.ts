// Integer-only money formatting. Never divides by 100 as a float.

const SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  CAD: 'CA$',
  AUD: 'A$',
};

export function formatMoney(cents: bigint, currency: string): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (abs % 100n).toString().padStart(2, '0');
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  return `${negative ? '-' : ''}${symbol}${whole}.${fraction}`;
}
