import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  createTestApp,
  isolateRateLimits,
  registerAndLogin,
  TestApp,
} from './support/test-app';

const PASSWORD = 'a-long-enough-password';
const NEW_PASSWORD = 'a-brand-new-password-1';
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('Account recovery (e2e)', () => {
  let t: TestApp;
  const emails: string[] = [];
  const http = () => request(t.app.getHttpServer());

  const forgot = (email: string) =>
    http().post('/v1/auth/password/forgot').send({ email });
  const reset = (token: string, password: string) =>
    http().post('/v1/auth/password/reset').send({ token, password });
  const resend = (email: string) =>
    http().post('/v1/auth/resend-verification').send({ email });
  const login = (email: string, password: string) =>
    http().post('/v1/auth/login').send({ email, password });
  const resetTokensFor = (email: string) =>
    t.mail.resets.filter((m) => m.to === email).map((m) => m.token);

  async function newVerifiedUser() {
    const user = await registerAndLogin(t);
    emails.push(user.email);
    return user;
  }

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => isolateRateLimits(t));
  afterAll(async () => {
    await t.prisma.user.deleteMany({ where: { email: { in: emails } } });
    await t.app.close();
  });

  describe('forgot password', () => {
    it('answers identically for known and unknown emails, and mails only the known one', async () => {
      const { email } = await newVerifiedUser();
      const unknown = `${randomUUID()}@example.test`;

      const known = await forgot(email);
      const missing = await forgot(unknown);

      expect(known.status).toBe(202);
      expect(missing.status).toBe(known.status);
      expect(missing.body).toEqual(known.body);
      expect(resetTokensFor(email)).toHaveLength(1);
      expect(resetTokensFor(unknown)).toHaveLength(0);
    });

    it('stores only a hash of the reset token', async () => {
      const { email } = await newVerifiedUser();
      await forgot(email).expect(202);
      const [token] = resetTokensFor(email);

      const user = await t.prisma.user.findUnique({ where: { email } });
      const row = await t.prisma.authToken.findFirst({
        where: { userId: user!.id, type: 'PASSWORD_RESET' },
      });
      expect(row?.tokenHash).toBe(sha256(token));
      expect(row?.tokenHash).not.toBe(token);
    });

    it('limits emails per address but still answers 202', async () => {
      const { email } = await newVerifiedUser();
      for (let i = 0; i < 5; i++) {
        await forgot(email).expect(202);
      }
      expect(resetTokensFor(email)).toHaveLength(3);
    });

    it('a newer link invalidates the previous one', async () => {
      const { email } = await newVerifiedUser();
      await forgot(email).expect(202);
      await forgot(email).expect(202);
      const [first, second] = resetTokensFor(email);

      await reset(first, NEW_PASSWORD).expect(400);
      await reset(second, NEW_PASSWORD).expect(200);
    });
  });

  describe('reset password', () => {
    it('changes the password, makes the link single-use, and ends every session', async () => {
      const { email, refreshToken } = await newVerifiedUser();
      await forgot(email).expect(202);
      const [token] = resetTokensFor(email);

      await reset(token, NEW_PASSWORD).expect(200);

      await login(email, PASSWORD).expect(401);
      await login(email, NEW_PASSWORD).expect(200);

      const replay = await reset(token, 'yet-another-password-2');
      expect(replay.status).toBe(400);
      expect(replay.body.code).toBe('invalid_or_expired_token');

      // The session that existed before the reset can no longer refresh.
      const refresh = await http()
        .post('/v1/auth/refresh')
        .set('X-Requested-With', 'e2e')
        .set('Cookie', `refresh_token=${refreshToken}`);
      expect(refresh.status).toBe(401);
    });

    it('rejects an unknown token', async () => {
      const res = await reset('not-a-real-token', NEW_PASSWORD);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_or_expired_token');
    });

    it('rejects an expired token', async () => {
      const { email } = await newVerifiedUser();
      await forgot(email).expect(202);
      const [token] = resetTokensFor(email);
      await t.prisma.authToken.updateMany({
        where: { user: { email }, type: 'PASSWORD_RESET' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await reset(token, NEW_PASSWORD).expect(400);
    });

    it('rejects a weak password without consuming the link', async () => {
      const { email } = await newVerifiedUser();
      await forgot(email).expect(202);
      const [token] = resetTokensFor(email);

      const weak = await reset(token, 'short');
      expect(weak.status).toBe(400);
      expect(weak.body.code).toBe('validation_failed');

      await reset(token, NEW_PASSWORD).expect(200);
    });

    it('also verifies the email of an unverified account', async () => {
      const email = `${randomUUID()}@example.test`;
      emails.push(email);
      await http()
        .post('/v1/auth/signup')
        .send({ email, password: PASSWORD })
        .expect(202);
      await forgot(email).expect(202);

      await reset(resetTokensFor(email)[0], NEW_PASSWORD).expect(200);

      const user = await t.prisma.user.findUnique({ where: { email } });
      expect(user?.emailVerifiedAt).not.toBeNull();
      await login(email, NEW_PASSWORD).expect(200);
    });
  });

  describe('resend verification', () => {
    it('issues a fresh link and retires the old one', async () => {
      const email = `${randomUUID()}@example.test`;
      emails.push(email);
      await http()
        .post('/v1/auth/signup')
        .send({ email, password: PASSWORD })
        .expect(202);

      await resend(email).expect(202);
      const tokens = t.mail.verifications
        .filter((m) => m.to === email)
        .map((m) => m.token);
      expect(tokens).toHaveLength(2);

      await http()
        .post('/v1/auth/verify-email')
        .send({ token: tokens[0] })
        .expect(400);
      await http()
        .post('/v1/auth/verify-email')
        .send({ token: tokens[1] })
        .expect(200);
    });

    it('sends nothing for verified or unknown accounts, with the same response', async () => {
      const { email } = await newVerifiedUser();
      const before = t.mail.verifications.length;

      const verified = await resend(email);
      const unknown = await resend(`${randomUUID()}@example.test`);

      expect(verified.status).toBe(202);
      expect(unknown.status).toBe(verified.status);
      expect(unknown.body).toEqual(verified.body);
      expect(t.mail.verifications.length).toBe(before);
    });
  });
});
