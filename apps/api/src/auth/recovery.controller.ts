import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RateLimit } from '../rate-limit/rate-limit.decorator';
import { AccountRecoveryService } from './account-recovery.service';
import {
  forgotPasswordSchema,
  resendVerificationSchema,
  resetPasswordSchema,
} from './auth.dto';
import { Public } from './public.decorator';

@Public()
@Controller('auth')
export class RecoveryController {
  constructor(private readonly recovery: AccountRecoveryService) {}

  @Post('password/forgot')
  @HttpCode(202)
  @RateLimit({ name: 'forgot', limit: 10, windowSeconds: 3600 })
  async forgot(
    @Body(new ZodValidationPipe(forgotPasswordSchema))
    body: z.infer<typeof forgotPasswordSchema>,
  ): Promise<{ message: string }> {
    await this.recovery.forgotPassword(body.email);
    return {
      message:
        'If an account exists for this email, a password reset link has been sent.',
    };
  }

  @Post('password/reset')
  @HttpCode(200)
  @RateLimit({ name: 'reset', limit: 10, windowSeconds: 60 })
  async reset(
    @Body(new ZodValidationPipe(resetPasswordSchema))
    body: z.infer<typeof resetPasswordSchema>,
  ): Promise<{ message: string }> {
    await this.recovery.resetPassword(body.token, body.password);
    return { message: 'Password updated. Please log in again.' };
  }

  @Post('resend-verification')
  @HttpCode(202)
  @RateLimit({ name: 'resend', limit: 10, windowSeconds: 3600 })
  async resend(
    @Body(new ZodValidationPipe(resendVerificationSchema))
    body: z.infer<typeof resendVerificationSchema>,
  ): Promise<{ message: string }> {
    await this.recovery.resendVerification(body.email);
    return {
      message:
        'If this account still needs verification, a new email has been sent.',
    };
  }
}
