import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { validateEnv, type Env } from '../src/config/env';
import { MailModule } from '../src/mail/mail.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { TenancyModule } from '../src/tenancy/tenancy.module';
import { MailService } from '../src/mail/mail.service';
import {
  MAIL_JOB_NAME,
  MAIL_TRANSPORT,
  type MailJob,
} from '../src/mail/mail.types';
import { EMAIL_QUEUE } from '../src/queue/queue.constants';
import { QueueModule } from '../src/queue/queue.module';

const mailpit = () => `http://localhost:${process.env.MAIL_UI_PORT ?? '8025'}`;

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function buildApp(transport?: {
  sendMail: () => Promise<unknown>;
}): Promise<INestApplication> {
  process.env.RUN_WORKERS = 'true';
  process.env.QUEUE_PREFIX = `test-${randomUUID()}`;
  let builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        envFilePath: '../../.env',
        validate: validateEnv,
      }),
      PrismaModule,
      TenancyModule,
      QueueModule,
      MailModule,
    ],
  });
  if (transport) {
    builder = builder.overrideProvider(MAIL_TRANSPORT).useValue(transport);
  }
  const app = (await builder.compile()).createNestApplication();
  await app.init();
  return app;
}

describe('Mail queue: real delivery to Mailpit (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.get<Queue>(EMAIL_QUEUE).obliterate({ force: true });
    await app.close();
  });

  async function inbox(to: string) {
    const res = await fetch(
      `${mailpit()}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
    );
    const body = (await res.json()) as { messages: { ID: string }[] };
    return body.messages;
  }

  it('delivers a verification email with the link and no leftover job', async () => {
    const to = `verify-${randomUUID()}@example.test`;
    const token = `tok_${randomUUID()}`;
    await app.get(MailService).sendVerificationEmail(to, token);

    const [message] = await waitFor(async () => {
      const found = await inbox(to);
      return found.length > 0 ? found : undefined;
    });
    const detail = (await (
      await fetch(`${mailpit()}/api/v1/message/${message.ID}`)
    ).json()) as { Subject: string; Text: string };

    const webUrl = app
      .get(ConfigService<Env, true>)
      .get('WEB_URL', { infer: true });
    expect(detail.Subject).toBe('Verify your email address');
    expect(detail.Text).toContain(`${webUrl}/verify-email?token=${token}`);

    // Completed jobs are removed so one-time tokens do not linger in Redis.
    const queue = app.get<Queue>(EMAIL_QUEUE);
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'completed',
    );
    expect(counts).toMatchObject({ waiting: 0, delayed: 0, completed: 0 });
  });

  it('delivers password-reset and account-exists emails', async () => {
    const mail = app.get(MailService);
    const resetTo = `reset-${randomUUID()}@example.test`;
    const existsTo = `exists-${randomUUID()}@example.test`;
    await mail.sendPasswordResetEmail(resetTo, 'tok_reset');
    await mail.sendAccountExistsEmail(existsTo);

    for (const to of [resetTo, existsTo]) {
      const found = await waitFor(async () => {
        const messages = await inbox(to);
        return messages.length > 0 ? messages : undefined;
      });
      expect(found).toHaveLength(1);
    }
  });
});

describe('Mail queue: retries and failure handling (e2e)', () => {
  const transport = {
    calls: 0,
    failFirst: 0,
    async sendMail() {
      this.calls += 1;
      if (this.calls <= this.failFirst) throw new Error('smtp down');
      return {};
    },
  };
  let app: INestApplication;
  let queue: Queue<MailJob>;

  beforeAll(async () => {
    app = await buildApp(transport);
    queue = app.get<Queue<MailJob>>(EMAIL_QUEUE);
  });
  afterAll(async () => {
    await app.get<Queue>(EMAIL_QUEUE).obliterate({ force: true });
    await app.close();
  });
  beforeEach(() => {
    transport.calls = 0;
    transport.failFirst = 0;
  });

  const job: MailJob = { kind: 'account-exists', to: 'retry@example.test' };
  const fastRetry = {
    attempts: 3,
    backoff: { type: 'fixed' as const, delay: 50 },
  };

  it('retries a failing send and succeeds once the transport recovers', async () => {
    transport.failFirst = 2;
    await queue.add(MAIL_JOB_NAME, job, { ...fastRetry, jobId: randomUUID() });

    await waitFor(() => (transport.calls >= 3 ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(transport.calls).toBe(3); // no extra attempts after success
  }, 15_000);

  it('gives up after the configured attempts and keeps the job as failed', async () => {
    transport.failFirst = 999;
    const jobId = randomUUID();
    await queue.add(MAIL_JOB_NAME, job, { ...fastRetry, attempts: 2, jobId });

    const failed = await waitFor(async () => {
      const found = await queue.getJob(jobId);
      return found && (await found.isFailed()) ? found : undefined;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(transport.calls).toBe(2); // stopped, not retrying forever
    expect(failed.attemptsMade).toBe(2);
    await failed.remove();
  }, 15_000);
});
