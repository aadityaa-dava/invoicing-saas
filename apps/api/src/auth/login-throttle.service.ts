import { Injectable } from '@nestjs/common';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { RateLimitedException } from '../rate-limit/rate-limit.exception';
import { TokenService } from './token.service';

const MAX_FAILURES = 5;
const WINDOW_SECONDS = 15 * 60;

// Per-account brute-force protection, independent of the caller's IP.
// Emails are hashed so no addresses are stored in Redis keys.
@Injectable()
export class LoginThrottleService {
  constructor(
    private readonly limiter: RateLimitService,
    private readonly tokens: TokenService,
  ) {}

  private key(email: string): string {
    return `login-fail:${this.tokens.hashToken(email)}`;
  }

  async assertAllowed(email: string): Promise<void> {
    const status = await this.limiter.status(this.key(email));
    if (status.count >= MAX_FAILURES) {
      throw new RateLimitedException(status.retryAfterSeconds);
    }
  }

  async recordFailure(email: string): Promise<void> {
    await this.limiter.hit(this.key(email), MAX_FAILURES, WINDOW_SECONDS);
  }

  async recordSuccess(email: string): Promise<void> {
    await this.limiter.reset(this.key(email));
  }
}
