import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

describe('Authentication guard and /me (e2e)', () => {
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

  it('rejects a request with no token', async () => {
    const res = await http().get('/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthenticated');
  });

  it('rejects a non-Bearer scheme', async () => {
    const res = await http().get('/v1/me').set('Authorization', 'Basic abc');
    expect(res.status).toBe(401);
  });

  it('rejects a garbage token', async () => {
    const res = await http()
      .get('/v1/me')
      .set('Authorization', 'Bearer not.a.token');
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const jwt = t.app.get(JwtService, { strict: false });
    const expired = await jwt.signAsync({}, { subject: 'u', expiresIn: -10 });
    const res = await http()
      .get('/v1/me')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it('returns the profile for a valid token, without the password hash', async () => {
    const { email, accessToken } = await registerAndLogin(t);
    emails.push(email);

    const res = await http()
      .get('/v1/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.email).toBe(email);
    expect(res.body.emailVerifiedAt).not.toBeNull();
    expect(res.body).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain('argon2');
  });

  it('keeps health checks and auth routes public', async () => {
    await http().get('/health/live').expect(200);
    await http()
      .post('/v1/auth/login')
      .send({ email: 'nobody@example.test', password: 'x' })
      .expect(401);
  });
});
