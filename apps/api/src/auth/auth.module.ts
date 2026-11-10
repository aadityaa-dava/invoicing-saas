import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { Env } from '../config/env';
import { MailModule } from '../mail/mail.module';
import { AccountRecoveryService } from './account-recovery.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { LoginThrottleService } from './login-throttle.service';
import { MeController } from './me.controller';
import { PasswordService } from './password.service';
import { RecoveryController } from './recovery.controller';
import { TokenService } from './token.service';

@Module({
  imports: [
    MailModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
      }),
    }),
  ],
  controllers: [AuthController, RecoveryController, MeController],
  providers: [
    PasswordService,
    TokenService,
    AuthService,
    AccountRecoveryService,
    LoginThrottleService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AuthModule {}
