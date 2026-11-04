import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env';
import { Prisma } from '../generated/prisma/client';
import { AuthTokenType } from '../generated/prisma/enums';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // Always behaves the same from the caller's point of view, whether or not
  // the email is already registered. The hash is computed first in both cases
  // so response time does not reveal it either.
  async signup(email: string, password: string): Promise<void> {
    const passwordHash = await this.passwords.hash(password);

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      await this.mail.sendAccountExistsEmail(email);
      return;
    }

    let userId: string;
    try {
      const user = await this.prisma.user.create({
        data: { email, passwordHash },
      });
      userId = user.id;
    } catch (error) {
      // Two simultaneous signups for the same email: the unique index decides.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        await this.mail.sendAccountExistsEmail(email);
        return;
      }
      throw error;
    }

    const rawToken = this.tokens.generateOpaqueToken();
    await this.prisma.authToken.create({
      data: {
        userId,
        type: AuthTokenType.EMAIL_VERIFY,
        tokenHash: this.tokens.hashToken(rawToken),
        expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
      },
    });
    await this.mail.sendVerificationEmail(email, rawToken);
  }

  // The token is consumed with a single conditional UPDATE, so two concurrent
  // requests with the same link cannot both succeed.
  async verifyEmail(rawToken: string): Promise<void> {
    const tokenHash = this.tokens.hashToken(rawToken);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.authToken.updateMany({
        where: {
          tokenHash,
          type: AuthTokenType.EMAIL_VERIFY,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) {
        throw new BadRequestException({ code: 'invalid_or_expired_token' });
      }
      const token = await tx.authToken.findUniqueOrThrow({
        where: { tokenHash },
      });
      await tx.user.update({
        where: { id: token.userId },
        data: { emailVerifiedAt: now },
      });
    });
  }

  async login(email: string, password: string): Promise<SessionTokens> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Hash work happens even when the user does not exist.
    const valid = await this.passwords.verify(
      user?.passwordHash ?? null,
      password,
    );
    if (!user || !valid) {
      throw new UnauthorizedException({ code: 'invalid_credentials' });
    }
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException({ code: 'email_not_verified' });
    }
    return this.issueSession(user.id, randomUUID());
  }

  // A family groups every refresh token descended from one login, so a
  // detected theft can revoke the whole chain at once.
  private async issueSession(
    userId: string,
    familyId: string,
  ): Promise<SessionTokens> {
    const { token: accessToken, expiresIn } =
      await this.tokens.signAccessToken(userId);
    const refreshToken = this.tokens.generateOpaqueToken();
    const ttlDays = this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true });
    const refreshExpiresAt = new Date(Date.now() + ttlDays * DAY_MS);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: this.tokens.hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
      },
    });
    return { accessToken, expiresIn, refreshToken, refreshExpiresAt };
  }
}
