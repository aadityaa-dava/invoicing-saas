import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker, type Job, type Queue } from 'bullmq';
import { todayUtc } from '../common/dates';
import type { Env } from '../config/env';
import { bullConnection } from '../queue/bull-connection';
import {
  JOBS_QUEUE,
  JOBS_QUEUE_NAME,
  OVERDUE_ORG,
  OVERDUE_SWEEP,
  RECURRING_ORG,
  RECURRING_SWEEP,
  SCHEDULES,
  type JobData,
} from './jobs.constants';
import { OverdueService } from './overdue.service';
import { RecurringGenerationService } from './recurring-generation.service';

@Injectable()
export class JobsProcessor
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(JobsProcessor.name);
  private worker?: Worker<JobData>;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly overdue: OverdueService,
    private readonly generation: RecurringGenerationService,
    @Inject(JOBS_QUEUE) private readonly queue: Queue<JobData>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Only processes that run workers consume jobs and own the schedules.
    if (!this.config.get('RUN_WORKERS', { infer: true })) return;

    this.worker = new Worker<JobData>(
      JOBS_QUEUE_NAME,
      (job) => this.handle(job),
      {
        connection: bullConnection(
          this.config.get('REDIS_URL', { infer: true }),
        ),
        prefix: this.config.get('QUEUE_PREFIX', { infer: true }),
        concurrency: 3,
      },
    );
    this.worker.on('failed', (job, err) => {
      const attempts = job?.opts.attempts ?? 1;
      const message = `${job?.name} ${job?.id} failed, attempt ${job?.attemptsMade}/${attempts}: ${err.message}`;
      if (job && job.attemptsMade >= attempts) {
        this.logger.error(`${message} (giving up)`);
      } else {
        this.logger.warn(message);
      }
    });
    this.worker.on('error', (err) =>
      this.logger.error(`worker error: ${err.message}`),
    );

    try {
      await this.registerSchedules();
    } catch (err) {
      this.logger.error(
        `could not register schedules: ${(err as Error).message}`,
      );
    }
  }

  // Idempotent: the same ids update in place.
  async registerSchedules(): Promise<void> {
    for (const schedule of SCHEDULES) {
      await this.queue.upsertJobScheduler(
        schedule.id,
        { pattern: schedule.pattern, tz: 'UTC' },
        { name: schedule.job, data: {} },
      );
    }
  }

  private async handle(job: Job<JobData>): Promise<void> {
    // Fixed once per sweep, then carried by every per-org job, so a retry
    // after midnight still processes the original day.
    const asOf = job.data.asOf ?? todayUtc();
    switch (job.name) {
      case OVERDUE_SWEEP:
        return this.fanOut(
          OVERDUE_ORG,
          await this.overdue.findOrgsWithOverdueInvoices(asOf),
          asOf,
        );
      case RECURRING_SWEEP:
        return this.fanOut(
          RECURRING_ORG,
          await this.generation.findOrgsWithDueTemplates(asOf),
          asOf,
        );
      case OVERDUE_ORG: {
        const orgId = this.orgOf(job);
        const count = await this.overdue.markOverdue(orgId, asOf);
        this.logger.log(
          `overdue sweep org ${orgId} (${asOf}): ${count} invoices`,
        );
        return;
      }
      case RECURRING_ORG: {
        const orgId = this.orgOf(job);
        const result = await this.generation.generateForOrg(orgId, asOf);
        this.logger.log(
          `recurring generation org ${orgId} (${asOf}): ${result.invoices} invoices from ${result.templates} templates`,
        );
        return;
      }
      default:
        throw new Error(`unknown job: ${job.name}`);
    }
  }

  // One small job per org: a slow or failing org never blocks the others,
  // and a retry is scoped to a single org. The deterministic job id also
  // dedupes a repeated sweep at the queue level.
  private async fanOut(name: string, orgIds: string[], asOf: string) {
    if (orgIds.length === 0) return;
    await this.queue.addBulk(
      orgIds.map((orgId) => ({
        name,
        data: { orgId, asOf },
        opts: { jobId: `${name}-${orgId}-${asOf}` },
      })),
    );
  }

  private orgOf(job: Job<JobData>): string {
    if (!job.data.orgId) throw new Error(`job ${job.id} has no orgId`);
    return job.data.orgId;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
