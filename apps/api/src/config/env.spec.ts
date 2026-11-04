import { validateEnv } from './env';

describe('validateEnv', () => {
  const valid = {
    DATABASE_URL: 'postgresql://u:p@localhost:5433/db',
    REDIS_URL: 'redis://localhost:6380',
  };

  it('applies defaults', () => {
    const env = validateEnv(valid);
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces PORT from a string', () => {
    expect(validateEnv({ ...valid, PORT: '5000' }).PORT).toBe(5000);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({ REDIS_URL: valid.REDIS_URL })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('never includes the offending value in the error message', () => {
    expect.assertions(2);
    try {
      validateEnv({ ...valid, DATABASE_URL: 'not-a-url-secret' });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).not.toContain('not-a-url-secret');
    }
  });
});
