import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { Env } from '../config/env';
import { loginSchema, signupSchema, verifyEmailSchema } from './auth.dto';
import { AuthService, SessionTokens } from './auth.service';
import { Public } from './public.decorator';

export const REFRESH_COOKIE = 'refresh_token';
const COOKIE_PATH = '/v1/auth';

@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

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

  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(
    @Body(new ZodValidationPipe(verifyEmailSchema))
    body: z.infer<typeof verifyEmailSchema>,
  ): Promise<{ message: string }> {
    await this.auth.verifyEmail(body.token);
    return { message: 'Email verified.' };
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema))
    body: z.infer<typeof loginSchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const session = await this.auth.login(body.email, body.password);
    return this.respondWithSession(res, session);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    this.assertCsrfHeader(req);
    const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!raw) {
      throw new UnauthorizedException({ code: 'invalid_refresh_token' });
    }
    try {
      const session = await this.auth.refresh(raw);
      return this.respondWithSession(res, session);
    } catch (error) {
      if (error instanceof UnauthorizedException) this.clearRefreshCookie(res);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    this.assertCsrfHeader(req);
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE] as string | undefined);
    this.clearRefreshCookie(res);
  }

  // Browsers do not let other sites attach a custom header to a request
  // without a CORS preflight, so this complements SameSite=Strict.
  private assertCsrfHeader(req: Request): void {
    if (!req.headers['x-requested-with']) {
      throw new ForbiddenException({ code: 'csrf_check_failed' });
    }
  }

  private cookieBase() {
    return {
      httpOnly: true,
      secure: this.config.get('NODE_ENV', { infer: true }) === 'production',
      sameSite: 'strict' as const,
      path: COOKIE_PATH,
    };
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, this.cookieBase());
  }

  private respondWithSession(
    res: Response,
    session: SessionTokens,
  ): { accessToken: string; expiresIn: number } {
    res.setHeader('Cache-Control', 'no-store');
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      ...this.cookieBase(),
      expires: session.refreshExpiresAt,
    });
    return { accessToken: session.accessToken, expiresIn: session.expiresIn };
  }
}
