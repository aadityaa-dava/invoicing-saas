import { validateEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5433/db',
  REDIS_URL: 'redis://localhost:6380',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('Stripe environment validation', () => {
  it('boots without any Stripe variables', () => {
    const env = validateEnv(base);
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it('treats empty values as unset', () => {
    const env = validateEnv({
      ...base,
      STRIPE_SECRET_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      STRIPE_PRICE_PRO: '',
    });
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.STRIPE_WEBHOOK_SECRET).toBeUndefined();
    expect(env.STRIPE_PRICE_PRO).toBeUndefined();
  });

  it('accepts test-mode values', () => {
    const env = validateEnv({
      ...base,
      STRIPE_SECRET_KEY: 'sk_test_abcdefgh12345678',
      STRIPE_WEBHOOK_SECRET: 'whsec_abcdefgh12345678',
      STRIPE_PRICE_PRO: 'price_abcdefgh12345678',
    });
    expect(env.STRIPE_SECRET_KEY).toBe('sk_test_abcdefgh12345678');
  });

  it.each([
    'sk_live_abcdefgh12345678',
    'rk_test_abcdefgh12345678',
    'sk_test_short',
    'abc',
  ])('rejects %s as the secret key and does not echo it', (key) => {
    let message = '';
    try {
      validateEnv({ ...base, STRIPE_SECRET_KEY: key });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('STRIPE_SECRET_KEY');
    expect(message).toContain('test-mode');
    expect(message).not.toContain(key);
  });

  it('rejects a webhook secret without the whsec_ prefix', () => {
    expect(() =>
      validateEnv({ ...base, STRIPE_WEBHOOK_SECRET: 'abcdefgh12345678' }),
    ).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('rejects a price id without the price_ prefix', () => {
    expect(() =>
      validateEnv({ ...base, STRIPE_PRICE_PRO: 'prod_abcdefgh12345678' }),
    ).toThrow(/STRIPE_PRICE_PRO/);
  });
});
