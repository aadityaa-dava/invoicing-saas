import {
  firstRunOnOrAfter,
  nthRunDate,
  runDateOrNull,
  type Frequency,
} from './recurring-schedule';

const runs = (anchor: string, f: Frequency, count: number) =>
  Array.from({ length: count }, (_, n) => nthRunDate(anchor, f, n));

describe('nthRunDate', () => {
  it('returns the anchor itself for run 0', () => {
    for (const f of ['weekly', 'monthly', 'quarterly', 'yearly'] as const) {
      expect(nthRunDate('2027-03-15', f, 0)).toBe('2027-03-15');
    }
  });

  it('clamps month-end anchors without drifting', () => {
    expect(runs('2027-01-31', 'monthly', 5)).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31', // back to the 31st: not stuck on the 28th
      '2027-04-30',
      '2027-05-31',
    ]);
  });

  it('uses the 29th of February in leap years', () => {
    expect(nthRunDate('2028-01-31', 'monthly', 1)).toBe('2028-02-29');
  });

  it('rolls a Feb 29 yearly anchor to Feb 28 and back to Feb 29', () => {
    expect(nthRunDate('2028-02-29', 'yearly', 1)).toBe('2029-02-28');
    expect(nthRunDate('2028-02-29', 'yearly', 4)).toBe('2032-02-29');
  });

  it('steps quarterly with clamping', () => {
    expect(runs('2026-11-30', 'quarterly', 5)).toEqual([
      '2026-11-30',
      '2027-02-28',
      '2027-05-30',
      '2027-08-30',
      '2027-11-30',
    ]);
  });

  it('steps weekly across month and year boundaries', () => {
    expect(runs('2026-12-28', 'weekly', 3)).toEqual([
      '2026-12-28',
      '2027-01-04',
      '2027-01-11',
    ]);
  });

  it('rolls monthly runs over year boundaries', () => {
    expect(nthRunDate('2026-12-15', 'monthly', 1)).toBe('2027-01-15');
    expect(nthRunDate('2026-12-15', 'monthly', 13)).toBe('2028-01-15');
  });

  it('is strictly increasing and never moves off the anchor day by more than clamping', () => {
    for (const f of ['weekly', 'monthly', 'quarterly', 'yearly'] as const) {
      const dates = runs('2027-01-31', f, 300);
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i] > dates[i - 1]).toBe(true);
      }
    }
    for (const date of runs('2027-01-31', 'monthly', 300)) {
      const [y, m, d] = date.split('-').map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      expect(d).toBe(Math.min(31, lastDay));
    }
  });

  it('rejects an invalid run number', () => {
    expect(() => nthRunDate('2027-01-31', 'monthly', -1)).toThrow(RangeError);
    expect(() => nthRunDate('2027-01-31', 'monthly', 1.5)).toThrow(RangeError);
  });
});

describe('runDateOrNull', () => {
  it('treats the end date as inclusive', () => {
    expect(runDateOrNull('2027-01-31', 'monthly', 1, '2027-02-28')).toBe(
      '2027-02-28',
    );
    expect(runDateOrNull('2027-01-31', 'monthly', 2, '2027-02-28')).toBeNull();
  });

  it('has no end when endDate is null', () => {
    expect(runDateOrNull('2027-01-31', 'monthly', 50, null)).not.toBeNull();
  });
});

describe('firstRunOnOrAfter', () => {
  it('returns the anchor when it is not in the past', () => {
    expect(
      firstRunOnOrAfter('2026-01-31', 'monthly', '2026-01-31', null),
    ).toEqual({
      runCount: 0,
      nextRunOn: '2026-01-31',
    });
  });

  it('skips runs that are already in the past', () => {
    expect(
      firstRunOnOrAfter('2026-01-31', 'monthly', '2026-03-01', null),
    ).toEqual({
      runCount: 2,
      nextRunOn: '2026-03-31',
    });
  });

  it('counts a run falling on today as due', () => {
    expect(
      firstRunOnOrAfter('2026-01-31', 'monthly', '2026-03-31', null),
    ).toEqual({
      runCount: 2,
      nextRunOn: '2026-03-31',
    });
  });

  it('ends the schedule when every remaining run is past the end date', () => {
    expect(
      firstRunOnOrAfter('2026-01-31', 'monthly', '2026-06-01', '2026-03-31'),
    ).toEqual({ runCount: 3, nextRunOn: null });
  });
});
