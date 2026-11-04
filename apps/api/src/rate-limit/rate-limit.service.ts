import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';

export interface HitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

// Fixed-window counters in Redis. The window starts at the first hit and the
// key expires on its own, so nothing needs cleaning up.
@Injectable()
export class RateLimitService {
  // Tests set a unique prefix so runs never share counters.
  keyPrefix = 'rl';

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private fullKey(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }

  async hit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<HitResult> {
    const fullKey = this.fullKey(key);
    // EXPIRE ... NX only sets the TTL when none exists, so the window is fixed.
    const results = await this.redis
      .multi()
      .incr(fullKey)
      .expire(fullKey, windowSeconds, 'NX')
      .ttl(fullKey)
      .exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[2]?.[1] ?? windowSeconds);
    return {
      allowed: count <= limit,
      count,
      retryAfterSeconds: Math.max(ttl, 1),
    };
  }

  async status(
    key: string,
  ): Promise<{ count: number; retryAfterSeconds: number }> {
    const fullKey = this.fullKey(key);
    const results = await this.redis.multi().get(fullKey).ttl(fullKey).exec();
    const count = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[1]?.[1] ?? 0);
    return { count, retryAfterSeconds: Math.max(ttl, 1) };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.fullKey(key));
  }
}
