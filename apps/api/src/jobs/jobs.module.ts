import { Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Env } from '../config/env';
import { BillingModule } from '../billing/billing.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { bullConnection } from '../queue/bull-connection';
import { JOBS_QUEUE, JOBS_QUEUE_NAME, type JobData } from './jobs.constants';
import { JobsProcessor } from './jobs.processor';
import { OverdueService } from './overdue.service';
import { RecurringGenerationService } from './recurring-generation.service';

@Module({
  imports: [InvoicesModule, BillingModule],
  providers: [
    OverdueService,
    RecurringGenerationService,
    JobsProcessor,
    {
      // Its own queue, so a flood of emails can never delay billing jobs.
      provide: JOBS_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const queue = new Queue<JobData>(JOBS_QUEUE_NAME, {
          connection: bullConnection(config.get('REDIS_URL', { infer: true })),
          prefix: config.get('QUEUE_PREFIX', { infer: true }),
          defaultJobOptions: {
            // Safe to retry: every job is idempotent.
            attempts: 3,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: { age: 86_400, count: 1_000 },
            // Kept for a week: this is the dead-letter record.
            removeOnFail: { age: 7 * 86_400 },
          },
        });
        queue.on('error', (err) =>
          new Logger('JobsQueue').error(`queue error: ${err.message}`),
        );
        return queue;
      },
    },
  ],
  exports: [OverdueService, RecurringGenerationService],
})
export class JobsModule implements OnApplicationShutdown {
  constructor(@Inject(JOBS_QUEUE) private readonly queue: Queue<JobData>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
