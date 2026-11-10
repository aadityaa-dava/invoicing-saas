import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Env } from '../config/env';
import { bullConnection } from './bull-connection';
import { EMAIL_QUEUE, EMAIL_QUEUE_NAME } from './queue.constants';

@Global()
@Module({
  providers: [
    {
      provide: EMAIL_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const queue = new Queue(EMAIL_QUEUE_NAME, {
          connection: bullConnection(config.get('REDIS_URL', { infer: true })),
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
            // Jobs can carry one-time tokens: drop them as soon as they are
            // delivered, and keep failures only briefly for inspection.
            removeOnComplete: true,
            removeOnFail: { age: 24 * 3600, count: 1000 },
          },
        });
        queue.on('error', (err) =>
          new Logger('EmailQueue').error(`queue error: ${err.message}`),
        );
        return queue;
      },
    },
  ],
  exports: [EMAIL_QUEUE],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(@Inject(EMAIL_QUEUE) private readonly queue: Queue) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
