import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, TestApp } from './support/test-app';

const PASSWORD = 'a-long-enough-password';
const CSRF = { 'X-Requested-With': 'e2e' };

describe('Auth refresh and logout (e2e)', () => {
  let t: TestApp;
  const emails: string[] = [];
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.prisma.user.deleteMany({ where: { email: { in: emails } } });
    await t.app.close();
  });

  const cookieValue = (res: request.Response): string | undefined => {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    const line = cookies.find((c) => c.startsWith('refresh_token='));
    return line ? /refresh_token=([^;]*)/.exec(line)![1] : undefined;
  };

  // Registers, verifies and logs in a fresh user.
  async function loggedInUser() {
    const email = `${randomUUID()}@example.test`;
    emails.push(email);
    await http()
      .post('/v1/auth/signup')
      .send({ email, password: PASSWORD })
      .expect(202);
    const token = t.mail.verifications.filter((m) => m.to === email).at(-1)!
      .token;
    await http().post('/v1/auth/verify-email').send({ token }).expect(200);
    const login = await http()
      .post('/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return { email, refresh: cookieValue(login)! };
  }

  const refreshWith = (raw: string) =>
    http()
      .post('/v1/auth/refresh')
      .set(CSRF)
      .set('Cookie', `refresh_token=${raw}`);

  it('rotates the token: new access token, new cookie, old token marked used', async () => {
    const { email, refresh } = await loggedInUser();

    const res = await refreshWith(refresh).expect(200);
    const next = cookieValue(res)!;
    expect(next).toBeTruthy();
    expect(next).not.toBe(refresh);
    expect(res.body.accessToken).toEqual(expect.any(String));

    const rows = await t.prisma.refreshToken.findMany({
      where: { user: { email } },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].usedAt).not.toBeNull();
    expect(rows[1].usedAt).toBeNull();
    expect(rows[1].familyId).toBe(rows[0].familyId);
  });

  it('rejects refresh without the CSRF header', async () => {
    const { refresh } = await loggedInUser();
    const res = await http()
      .post('/v1/auth/refresh')
      .set('Cookie', `refresh_token=${refresh}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('csrf_check_failed');
  });

  it('rejects refresh with no cookie', async () => {
    const res = await http().post('/v1/auth/refresh').set(CSRF);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_refresh_token');
  });

  it('rejects an unknown token', async () => {
    const res = await refreshWith('made-up-token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('invalid_refresh_token');
  });

  it('rejects an expired token', async () => {
    const { email, refresh } = await loggedInUser();
    await t.prisma.refreshToken.updateMany({
      where: { user: { email } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await refreshWith(refresh);
    expect(res.status).toBe(401);
  });

  it('detects reuse of an old token and revokes the whole family', async () => {
    const { email, refresh: first } = await loggedInUser();

    const rotated = await refreshWith(first).expect(200);
    const second = cookieValue(rotated)!;

    // An attacker (or a buggy client) replays the already-used token.
    const replay = await refreshWith(first);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('refresh_token_reused');

    // The newest token from the same family is now dead too.
    const afterRevoke = await refreshWith(second);
    expect(afterRevoke.status).toBe(401);

    const rows = await t.prisma.refreshToken.findMany({
      where: { user: { email } },
    });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it('logout revokes the session, clears the cookie, and is idempotent', async () => {
    const { refresh } = await loggedInUser();

    const out = await http()
      .post('/v1/auth/logout')
      .set(CSRF)
      .set('Cookie', `refresh_token=${refresh}`);
    expect(out.status).toBe(204);
    expect(cookieValue(out)).toBe('');

    const after = await refreshWith(refresh);
    expect(after.status).toBe(401);

    const again = await http().post('/v1/auth/logout').set(CSRF);
    expect(again.status).toBe(204);
  });
});
