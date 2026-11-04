import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, TestApp } from './support/test-app';

describe('Auth signup (e2e)', () => {
  let t: TestApp;
  const createdEmails: string[] = [];
  const newEmail = () => {
    const email = `${randomUUID()}@example.test`;
    createdEmails.push(email);
    return email;
  };
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    await t.app.close();
  });

  const signup = (body: object) => http().post('/v1/auth/signup').send(body);

  it('creates the user, stores only hashes, and sends a verification email', async () => {
    const email = newEmail();
    const res = await signup({ email, password: 'a-long-enough-password' });
    expect(res.status).toBe(202);

    const user = await t.prisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(user?.emailVerifiedAt).toBeNull();

    const sent = t.mail.verifications.find((m) => m.to === email);
    expect(sent).toBeDefined();
    const stored = await t.prisma.authToken.findFirst({
      where: { userId: user!.id },
    });
    expect(stored?.type).toBe('EMAIL_VERIFY');
    expect(stored?.tokenHash).toBe(
      createHash('sha256').update(sent!.token).digest('hex'),
    );
    expect(stored?.tokenHash).not.toBe(sent!.token);
  });

  it('normalizes the email to lowercase', async () => {
    const email = newEmail();
    await signup({
      email: email.toUpperCase(),
      password: 'a-long-enough-password',
    });
    expect(
      await t.prisma.user.findUnique({ where: { email } }),
    ).not.toBeNull();
  });

  it('gives the same response for an already-registered email and creates no duplicate', async () => {
    const email = newEmail();
    const first = await signup({ email, password: 'a-long-enough-password' });
    const second = await signup({ email, password: 'another-long-password' });
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await t.prisma.user.count({ where: { email } })).toBe(1);
    expect(t.mail.existing).toContain(email);
  });

  it('rejects an invalid email with problem+json', async () => {
    const res = await signup({
      email: 'nope',
      password: 'a-long-enough-password',
    });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('validation_failed');
  });

  it('rejects a short password', async () => {
    const res = await signup({ email: newEmail(), password: 'short' });
    expect(res.status).toBe(400);
  });

  it('rejects unknown fields instead of ignoring them', async () => {
    const res = await signup({
      email: newEmail(),
      password: 'a-long-enough-password',
      isAdmin: true,
    });
    expect(res.status).toBe(400);
  });
});
