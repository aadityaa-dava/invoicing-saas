import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, type Job } from 'bullmq';
import type { Env } from '../config/env';
import { bullConnection } from '../queue/bull-connection';
import { EMAIL_QUEUE_NAME } from '../queue/queue.constants';
import { renderMail } from './mail.templates';
import { MAIL_TRANSPORT, type MailJob, type MailTransport } from './mail.types';

@Injectable()
export class MailProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MailProcessor.name);
  private worker?: Worker<MailJob>;

  constructor(
    private readonly config: ConfigService<Env, true>,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('RUN_WORKERS', { infer: true })) return;

    this.worker = new Worker<MailJob>(
      EMAIL_QUEUE_NAME,
      (job) => this.handle(job),
      {
        connection: bullConnection(this.config.get('REDIS_URL', { infer: true })),
        concurrency: 5,
      },
    );
    // Log job id and kind only: payloads can contain one-time tokens.
    this.worker.on('failed', (job, err) =>
      this.logger.warn(
        `mail job ${job?.id} (${job?.data.kind}) failed, attempt ${job?.attemptsMade}/${job?.opts.attempts}: ${err.message}`,
      ),
    );
    this.worker.on('error', (err) =>
      this.logger.error(`worker error: ${err.message}`),
    );
  }

  private async handle(job: Job<MailJob>): Promise<void> {
    const message = renderMail(job.data, this.config.get('WEB_URL', { infer: true }));
    await this.transport.sendMail({
      from: this.config.get('MAIL_FROM', { infer: true }),
      ...message,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
