import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { validateEnv } from './config/env';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';
import { RedisModule } from './redis/redis.module';

// RateLimitModule is imported before AuthModule so its guard runs first:
// unauthenticated brute force is throttled before any token is examined.
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../../.env',
      validate: validateEnv,
    }),
    PrismaModule,
    RedisModule,
    RateLimitModule,
    AuthModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
