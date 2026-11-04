import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../auth/public.decorator';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // Liveness: the process is running. No dependencies are checked.
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  // Readiness: the app can serve traffic, so its dependencies must answer.
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: { database: 'up' } }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        checks: { database: 'down' },
      });
    }
    return { status: 'ok', checks: { database: 'up' } };
  }
}
