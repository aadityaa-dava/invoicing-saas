import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';

// Development stub. Phase 7 replaces this with queued, retried delivery.
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    if (this.config.get('NODE_ENV', { infer: true }) === 'production') return;
    const webUrl = this.config.get('WEB_URL', { infer: true });
    this.logger.log(`[dev mail] verify ${to}: ${webUrl}/verify-email?token=${token}`);
  }

  async sendAccountExistsEmail(to: string): Promise<void> {
    if (this.config.get('NODE_ENV', { infer: true }) === 'production') return;
    this.logger.log(`[dev mail] ${to} already has an account`);
  }
}
