import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

type CheckResult = 'up' | 'down';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // Liveness: the process is running. No dependencies are checked, so a
  // database outage never causes a pointless restart.
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // Readiness: the instance can serve traffic, so its dependencies must answer.
  @Get('ready')
  async ready(): Promise<{
    status: 'ok';
    checks: { database: CheckResult; redis: CheckResult };
  }> {
    const [database, redis] = await Promise.all([
      this.check(() => this.prisma.$queryRaw`SELECT 1`),
      this.check(() => this.redis.ping()),
    ]);
    const checks = { database, redis };
    if (database === 'down' || redis === 'down') {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        checks,
      });
    }
    return { status: 'ok', checks };
  }

  // A hanging dependency must not make the probe hang too.
  private async check(probe: () => Promise<unknown>): Promise<CheckResult> {
    try {
      await Promise.race([
        probe(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 2000).unref(),
        ),
      ]);
      return 'up';
    } catch {
      return 'down';
    }
  }
}
