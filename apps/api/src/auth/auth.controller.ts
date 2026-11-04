import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { signupSchema } from './auth.dto';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  @HttpCode(202)
  async signup(
    @Body(new ZodValidationPipe(signupSchema))
    body: z.infer<typeof signupSchema>,
  ): Promise<{ message: string }> {
    await this.auth.signup(body.email, body.password);
    return {
      message:
        'If this email can be registered, a verification email has been sent.',
    };
  }
}
