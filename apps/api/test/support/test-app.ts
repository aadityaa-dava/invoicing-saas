import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { MailService } from '../../src/mail/mail.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RateLimitService } from '../../src/rate-limit/rate-limit.service';

export class FakeMailService {
  verifications: { to: string; token: string }[] = [];
  existing: string[] = [];
  async sendVerificationEmail(to: string, token: string) {
    this.verifications.push({ to, token });
  }
  async sendAccountExistsEmail(to: string) {
    this.existing.push(to);
  }
}

export async function createTestApp() {
  const mail = new FakeMailService();
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(MailService)
    .useValue(mail)
    .compile();
  const app: INestApplication = moduleFixture.createNestApplication();
  configureApp(app);
  await app.init();
  const t = { app, mail, prisma: app.get(PrismaService) };
  isolateRateLimits(t);
  return t;
}

export type TestApp = {
  app: INestApplication;
  mail: FakeMailService;
  prisma: PrismaService;
};

// Gives the app a fresh set of rate-limit counters, so tests and test runs
// never share state through Redis.
export function isolateRateLimits(t: TestApp): void {
  t.app.get(RateLimitService, { strict: false }).keyPrefix =
    `rl-test-${randomUUID()}`;
}

// Registers, verifies and logs in a brand-new user through the real API.
export async function registerAndLogin(
  t: TestApp,
  password = 'a-long-enough-password',
) {
  const email = `${randomUUID()}@example.test`;
  const http = () => request(t.app.getHttpServer());
  await http().post('/v1/auth/signup').send({ email, password }).expect(202);
  const token = t.mail.verifications.filter((m) => m.to === email).at(-1)!
    .token;
  await http().post('/v1/auth/verify-email').send({ token }).expect(200);
  const res = await http()
    .post('/v1/auth/login')
    .send({ email, password })
    .expect(200);
  return { email, accessToken: res.body.accessToken as string };
}
