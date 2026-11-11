import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { configureApp } from '../../src/app.setup';
import { MailService } from '../../src/mail/mail.service';
import { EMAIL_QUEUE } from '../../src/queue/queue.constants';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RateLimitService } from '../../src/rate-limit/rate-limit.service';

export class FakeMailService {
  verifications: { to: string; token: string }[] = [];
  resets: { to: string; token: string }[] = [];
  existing: string[] = [];
  invoiceEmails: { orgId: string; invoiceId: string }[] = [];
  // When set, invoice emails also go to the real queue (worker-backed suites).
  forward?: MailService;
  async sendVerificationEmail(to: string, token: string) {
    this.verifications.push({ to, token });
  }
  async sendPasswordResetEmail(to: string, token: string) {
    this.resets.push({ to, token });
  }
  async sendInvoiceEmail(orgId: string, invoiceId: string) {
    this.invoiceEmails.push({ orgId, invoiceId });
    await this.forward?.sendInvoiceEmail(orgId, invoiceId);
  }
  async sendAccountExistsEmail(to: string) {
    this.existing.push(to);
  }
}

export async function createTestApp(options: { workers?: boolean } = {}) {
  // Mail jobs are consumed only by the mail-queue suite, never by other suites.
  process.env.RUN_WORKERS = options.workers ? 'true' : 'false';
  if (options.workers) process.env.QUEUE_PREFIX = `test-${randomUUID()}`;
  const mail = new FakeMailService();
  // Loaded here, not at the top of the file: the config module freezes the
  // environment when AppModule is first evaluated, after RUN_WORKERS is set.
  const { AppModule } = await import('../../src/app.module.js');
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(MailService)
    .useValue(mail)
    .compile();
  const app: INestApplication = moduleFixture.createNestApplication();
  configureApp(app);
  await app.init();
  if (options.workers) {
    mail.forward = new MailService(app.get(EMAIL_QUEUE));
  }
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
  const token = t.mail.verifications
    .filter((m) => m.to === email)
    .at(-1)!.token;
  await http().post('/v1/auth/verify-email').send({ token }).expect(200);
  const res = await http()
    .post('/v1/auth/login')
    .send({ email, password })
    .expect(200);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const refreshToken = /refresh_token=([^;]+)/.exec(
    cookies.find((c) => c.startsWith('refresh_token='))!,
  )![1];
  return { email, accessToken: res.body.accessToken as string, refreshToken };
}
