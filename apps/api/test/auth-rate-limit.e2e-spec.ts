import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  createTestApp,
  isolateRateLimits,
  registerAndLogin,
  TestApp,
} from './support/test-app';

const PASSWORD = 'a-long-enough-password';

describe('Auth rate limiting (e2e)', () => {
  let t: TestApp;
  const emails: string[] = [];
  const http = () => request(t.app.getHttpServer());

  const login = (email: string, password: string) =>
    http().post('/v1/auth/login').send({ email, password });

  beforeAll(async () => {
    t = await createTestApp();
  });

  // Every test starts with clean counters.
  beforeEach(() => isolateRateLimits(t));

  afterAll(async () => {
    await t.prisma.user.deleteMany({ where: { email: { in: emails } } });
    await t.app.close();
  });

  it('blocks the 11th login attempt from one IP, even across different accounts', async () => {
    for (let i = 0; i < 10; i++) {
      await login(`${randomUUID()}@example.test`, 'x').expect(401);
    }
    const res = await login('someone@example.test', 'x');
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('locks one account after 5 failures, even for the correct password', async () => {
    const { email } = await registerAndLogin(t);
    emails.push(email);

    for (let i = 0; i < 5; i++) {
      await login(email, 'wrong-password-123').expect(401);
    }
    const locked = await login(email, PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('rate_limited');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('resets the failure counter after a successful login', async () => {
    const { email } = await registerAndLogin(t);
    emails.push(email);

    for (let i = 0; i < 3; i++) {
      await login(email, 'wrong-password-123').expect(401);
    }
    await login(email, PASSWORD).expect(200);
    // Without the reset these would hit the 5-failure lock.
    for (let i = 0; i < 3; i++) {
      await login(email, 'wrong-password-123').expect(401);
    }
    await login(email, PASSWORD).expect(200);
  });
});
