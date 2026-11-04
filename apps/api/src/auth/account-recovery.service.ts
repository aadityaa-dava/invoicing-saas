import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthTokenType } from '../generated/prisma/enums';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

const HOUR_MS = 60 * 60 * 1000;
const RESET_TTL_MS = HOUR_MS;
const VERIFY_TTL_MS = 24 * HOUR_MS;

// At most this many emails per address per hour, so the form cannot be used
// to flood someone's inbox.
const EMAILS_PER_ADDRESS = 3;

@Injectable()
export class AccountRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly limiter: RateLimitService,
  ) {}

  // The caller always gets the same answer. Whether anything was sent is
  // never revealed.
  async forgotPassword(email: string): Promise<void> {
    if (!(await this.withinEmailBudget('forgot', email))) return;
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return;
    const raw = await this.issueToken(
      user.id,
      AuthTokenType.PASSWORD_RESET,
      RESET_TTL_MS,
    );
    await this.mail.sendPasswordResetEmail(email, raw);
  }

  async resendVerification(email: string): Promise<void> {
    if (!(await this.withinEmailBudget('resend', email))) return;
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.emailVerifiedAt) return;
    const raw = await this.issueToken(
      user.id,
      AuthTokenType.EMAIL_VERIFY,
      VERIFY_TTL_MS,
    );
    await this.mail.sendVerificationEmail(email, raw);
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    // Hashed before the transaction so the slow work does not hold it open.
    const passwordHash = await this.passwords.hash(newPassword);
    const tokenHash = this.tokens.hashToken(rawToken);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.authToken.updateMany({
        where: {
          tokenHash,
          type: AuthTokenType.PASSWORD_RESET,
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
      const userId = token.userId;

      // Clicking a link sent to this address proves control of it.
      await tx.user.updateMany({
        where: { id: userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });

      // Every existing session ends, in case the account was compromised.
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      // Any other outstanding reset links die too.
      await tx.authToken.updateMany({
        where: { userId, type: AuthTokenType.PASSWORD_RESET, usedAt: null },
        data: { usedAt: now },
      });
    });
  }

  private async withinEmailBudget(kind: string, email: string): Promise<boolean> {
    const result = await this.limiter.hit(
      `${kind}:email:${this.tokens.hashToken(email)}`,
      EMAILS_PER_ADDRESS,
      3600,
    );
    return result.allowed;
  }

  // Only the newest link works: older unused ones are retired first.
  private async issueToken(
    userId: string,
    type: AuthTokenType,
    ttlMs: number,
  ): Promise<string> {
    await this.prisma.authToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: new Date() },
    });
    const raw = this.tokens.generateOpaqueToken();
    await this.prisma.authToken.create({
      data: {
        userId,
        type,
        tokenHash: this.tokens.hashToken(raw),
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
    return raw;
  }
}
