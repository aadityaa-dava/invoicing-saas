import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { EMAIL_QUEUE } from '../queue/queue.constants';
import { MAIL_JOB_NAME, type MailJob } from './mail.types';

// Enqueues mail instead of sending it inline: the request returns as soon as
// the job is stored in Redis, SMTP slowness never reaches the caller, and the
// worker retries failures with backoff.
@Injectable()
export class MailService {
  constructor(@Inject(EMAIL_QUEUE) private readonly queue: Queue<MailJob>) {}

  private async enqueue(job: MailJob): Promise<void> {
    await this.queue.add(MAIL_JOB_NAME, job);
  }

  sendVerificationEmail(to: string, token: string): Promise<void> {
    return this.enqueue({ kind: 'verify-email', to, token });
  }

  sendPasswordResetEmail(to: string, token: string): Promise<void> {
    return this.enqueue({ kind: 'password-reset', to, token });
  }

  sendAccountExistsEmail(to: string): Promise<void> {
    return this.enqueue({ kind: 'account-exists', to });
  }
}
