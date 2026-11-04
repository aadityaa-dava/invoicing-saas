import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rateLimit';

export interface RateLimitOptions {
  name: string;
  limit: number;
  windowSeconds: number;
}

// Per-IP limit for one route. Routes without it are not limited by the guard.
export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);
