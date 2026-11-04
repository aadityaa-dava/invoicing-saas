import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { MailService } from './../src/mail/mail.service';
import { PrismaService } from './../src/prisma/prisma.service';

class FakeMailService {
  verifications: { to: string; token: string }[] = [];
  existing: string[] = [];
  async sendVerificationEmail(to: string, token: string) {
    this.verifications.push({ to, token });
  }
  async sendAccountExistsEmail(to: string) {
    this.existing.push(to);
  }
}

describe('Auth signup (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const mail = new FakeMailService();
  const createdEmails: string[] = [];
  const newEmail = () => {
    const email = `${randomUUID()}@example.test`;
    createdEmails.push(email);
    return email;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MailService)
      .useValue(mail)
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    await app.close();
  });

  const signup = (body: object) =>
    request(app.getHttpServer()).post('/v1/auth/signup').send(body);

  it('creates the user, stores only hashes, and sends a verification email', async () => {
    const email = newEmail();
    const res = await signup({ email, password: 'a-long-enough-password' });
    expect(res.status).toBe(202);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(user?.emailVerifiedAt).toBeNull();

    const sent = mail.verifications.find((m) => m.to === email);
    expect(sent).toBeDefined();
    const stored = await prisma.authToken.findFirst({
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
    await signup({ email: email.toUpperCase(), password: 'a-long-enough-password' });
    expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();
  });

  it('gives the same response for an already-registered email and creates no duplicate', async () => {
    const email = newEmail();
    const first = await signup({ email, password: 'a-long-enough-password' });
    const second = await signup({ email, password: 'another-long-password' });
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    expect(mail.existing).toContain(email);
  });

  it('rejects an invalid email with problem+json', async () => {
    const res = await signup({ email: 'nope', password: 'a-long-enough-password' });
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
