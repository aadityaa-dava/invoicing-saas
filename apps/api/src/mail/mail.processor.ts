import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, type Job } from 'bullmq';
import type { Env } from '../config/env';
import { renderInvoicePdf } from '../invoices/invoice-pdf';
import { loadPdfData } from '../invoices/invoices.service';
import { bullConnection } from '../queue/bull-connection';
import { EMAIL_QUEUE_NAME } from '../queue/queue.constants';
import { TenantDb } from '../tenancy/tenant-db.service';
import { buildInvoiceEmail } from './invoice-email';
import { renderMail } from './mail.templates';
import {
  MAIL_TRANSPORT,
  type InvoiceSentJob,
  type MailJob,
  type MailTransport,
} from './mail.types';

const DELIVERABLE_STATUSES = ['sent', 'overdue', 'paid'];

@Injectable()
export class MailProcessor implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MailProcessor.name);
  private worker?: Worker<MailJob>;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly tenantDb: TenantDb,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('RUN_WORKERS', { infer: true })) return;

    this.worker = new Worker<MailJob>(
      EMAIL_QUEUE_NAME,
      (job) => this.handle(job),
      {
        connection: bullConnection(
          this.config.get('REDIS_URL', { infer: true }),
        ),
        prefix: this.config.get('QUEUE_PREFIX', { infer: true }),
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
    const data = job.data;
    if (data.kind === 'invoice-sent')
      return this.handleInvoiceSent(job.id, data);
    const message = renderMail(
      data,
      this.config.get('WEB_URL', { infer: true }),
    );
    await this.send(message);
  }

  private send(
    message: Omit<Parameters<MailTransport['sendMail']>[0], 'from'>,
  ) {
    return this.transport.sendMail({
      from: this.config.get('MAIL_FROM', { infer: true }),
      ...message,
    });
  }

  // Runs under the org's own row-level-security context, with no user.
  // Missing, void or recipient-less invoices are skipped, not retried: a retry
  // could never succeed.
  private async handleInvoiceSent(
    jobId: string | undefined,
    { orgId, invoiceId }: InvoiceSentJob,
  ): Promise<void> {
    let data;
    try {
      data = await this.tenantDb.run({ orgId }, (tx) =>
        loadPdfData(tx, orgId, invoiceId),
      );
    } catch (err) {
      if (err instanceof NotFoundException) {
        this.logger.warn(`job ${jobId}: invoice no longer exists, skipped`);
        return;
      }
      throw err;
    }
    if (!DELIVERABLE_STATUSES.includes(data.invoice.status)) {
      this.logger.warn(
        `job ${jobId}: invoice is ${data.invoice.status}, skipped`,
      );
      return;
    }
    const mail = buildInvoiceEmail(data, await renderInvoicePdf(data));
    if (!mail) {
      this.logger.warn(`job ${jobId}: client has no email, skipped`);
      return;
    }
    await this.send(mail);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
