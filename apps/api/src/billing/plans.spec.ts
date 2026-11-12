import { hasPaidPlan, isEntitledStatus } from './plans';

describe('plans', () => {
  it.each(['active', 'trialing', 'past_due'])('%s keeps the paid plan', (s) => {
    expect(isEntitledStatus(s)).toBe(true);
    expect(hasPaidPlan({ plan: 'pro', status: s })).toBe(true);
  });

  it.each(['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'])(
    '%s does not',
    (s) => {
      expect(isEntitledStatus(s)).toBe(false);
      expect(hasPaidPlan({ plan: 'pro', status: s })).toBe(false);
    },
  );

  it('the free plan and a missing subscription are never paid', () => {
    expect(hasPaidPlan({ plan: 'free', status: 'active' })).toBe(false);
    expect(hasPaidPlan(null)).toBe(false);
    expect(hasPaidPlan(undefined)).toBe(false);
  });
});
