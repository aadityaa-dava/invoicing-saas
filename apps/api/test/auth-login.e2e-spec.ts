import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { TokenService } from './../src/auth/token.service';
import { createTestApp, TestApp } from './support/test-app';

const PASSWORD = 'a-long-enough-password';
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('Auth verify-email and login (e2e)', () => {
  let t: TestApp;
  const emails: string[] = [];
  const newEmail = () => {
    const email = `${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  };
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.prisma.user.deleteMany({ where: { email: { in: emails } } });
    await t.app.close();
  });

  async function signup(email: string): Promise<string> {
    await http()
      .post('/v1/auth/signup')
      .send({ email, password: PASSWORD })
      .expect(202);
    return t.mail.verifications.filter((m) => m.to === email).at(-1)!.token;
  }

  async function registerVerified(email: string): Promise<void> {
    const token = await signup(email);
    await http().post('/v1/auth/verify-email').send({ token }).expect(200);
  }

  describe('verify-email', () => {
    it('verifies the user, and the same link cannot be used twice', async () => {
      const email = newEmail();
      const token = await signup(email);

      await http().post('/v1/auth/verify-email').send({ token }).expect(200);
      const user = await t.prisma.user.findUnique({ where: { email } });
      expect(user?.emailVerifiedAt).not.toBeNull();

      const replay = await http()
        .post('/v1/auth/verify-email')
        .send({ token });
      expect(replay.status).toBe(400);
      expect(replay.body.code).toBe('invalid_or_expired_token');
    });

    it('rejects a token that does not exist', async () => {
      const res = await http()
        .post('/v1/auth/verify-email')
        .send({ token: 'not-a-real-token' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_or_expired_token');
    });

    it('rejects an expired token', async () => {
      const email = newEmail();
      const token = await signup(email);
      await t.prisma.authToken.updateMany({
        where: { user: { email } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await http().post('/v1/auth/verify-email').send({ token });
      expect(res.status).toBe(400);
    });
  });

  describe('login', () => {
    it('refuses an unverified account with the right password', async () => {
      const email = newEmail();
      await signup(email);
      const res = await http()
        .post('/v1/auth/login')
        .send({ email, password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('email_not_verified');
    });

    it('issues an access token and a hardened refresh cookie', async () => {
      const email = newEmail();
      await registerVerified(email);

      const res = await http()
        .post('/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);

      const cookies = res.headers['set-cookie'] as unknown as string[];
      const cookie = cookies.find((c) => c.startsWith('refresh_token='))!;
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/v1/auth');
      expect(res.headers['cache-control']).toBe('no-store');

      const raw = /refresh_token=([^;]+)/.exec(cookie)![1];
      const row = await t.prisma.refreshToken.findFirst({
        where: { user: { email } },
      });
      expect(row?.tokenHash).toBe(sha256(raw));
      expect(row?.usedAt).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(raw);

      const claims = await t.app
        .get(TokenService, { strict: false })
        .verifyAccessToken(res.body.accessToken);
      expect(claims.sub).toBe(row?.userId);
    });

    it('gives identical responses for a wrong password and an unknown email', async () => {
      const email = newEmail();
      await registerVerified(email);

      const wrong = await http()
        .post('/v1/auth/login')
        .send({ email, password: 'definitely-wrong-password' });
      const unknown = await http()
        .post('/v1/auth/login')
        .send({ email: newEmail(), password: PASSWORD });

      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(wrong.status);
      expect(unknown.body).toEqual(wrong.body);
      expect(wrong.body.code).toBe('invalid_credentials');
    });
  });
});
