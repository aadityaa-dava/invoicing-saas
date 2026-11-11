export type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

const MONTHS_PER_STEP = { monthly: 1, quarterly: 3, yearly: 12 } as const;

// Far beyond any real template (100 years of weekly runs).
const MAX_RUNS = 5_200;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate(); // month is 1-based

// The date of run number n (0 is the anchor itself). Always computed from the
// anchor, never from the previous run, so a month-end anchor does not drift:
// Jan 31 gives Feb 28, then Mar 31 (not Mar 28). Days that do not exist in a
// month are clamped to its last day. All arithmetic is on UTC calendar days,
// so daylight-saving changes cannot move a date.
export function nthRunDate(
  anchor: string,
  frequency: Frequency,
  n: number,
): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError('run number must be a non-negative integer');
  }
  const [y, m, d] = anchor.split('-').map(Number);

  if (frequency === 'weekly') {
    return new Date(Date.UTC(y, m - 1, d + 7 * n)).toISOString().slice(0, 10);
  }

  const totalMonths = m - 1 + MONTHS_PER_STEP[frequency] * n;
  const year = y + Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const day = Math.min(d, daysInMonth(year, month));
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

// Run n, or null once it falls after the end date (the end date is inclusive).
export function runDateOrNull(
  anchor: string,
  frequency: Frequency,
  n: number,
  endDate: string | null,
): string | null {
  const date = nthRunDate(anchor, frequency, n);
  return endDate !== null && date > endDate ? null : date;
}

// The first run that is today or later. Used when a paused template resumes:
// runs missed while paused are skipped, not generated in a burst.
export function firstRunOnOrAfter(
  anchor: string,
  frequency: Frequency,
  today: string,
  endDate: string | null,
): { runCount: number; nextRunOn: string | null } {
  for (let n = 0; n < MAX_RUNS; n++) {
    const date = nthRunDate(anchor, frequency, n);
    if (endDate !== null && date > endDate) {
      return { runCount: n, nextRunOn: null };
    }
    if (date >= today) return { runCount: n, nextRunOn: date };
  }
  throw new RangeError('schedule is too long to resolve');
}
