import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';

// Development stub. Phase 7 replaces this with queued, retried delivery.
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  private get isProduction(): boolean {
    return this.config.get('NODE_ENV', { infer: true }) === 'production';
  }

  private get webUrl(): string {
    return this.config.get('WEB_URL', { infer: true });
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    if (this.isProduction) return;
    this.logger.log(`[dev mail] verify ${to}: ${this.webUrl}/verify-email?token=${token}`);
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    if (this.isProduction) return;
    this.logger.log(`[dev mail] reset ${to}: ${this.webUrl}/reset-password?token=${token}`);
  }

  async sendAccountExistsEmail(to: string): Promise<void> {
    if (this.isProduction) return;
    this.logger.log(`[dev mail] ${to} already has an account`);
  }
}
