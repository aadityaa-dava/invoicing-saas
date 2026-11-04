import { Injectable } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { Prisma } from '../generated/prisma/client';
import { AuthTokenType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
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
}
