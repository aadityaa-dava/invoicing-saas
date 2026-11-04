import { Controller, Get, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from './auth.types';
import { CurrentUser } from './current-user.decorator';

@Controller('me')
export class MeController {
  constructor(private readonly prisma: PrismaService) {}

  // Selects explicit fields so the password hash can never be returned.
  @Get()
  async me(@CurrentUser() user: AuthUser) {
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, email: true, emailVerifiedAt: true, createdAt: true },
    });
    if (!row) throw new UnauthorizedException({ code: 'unauthenticated' });
    return row;
  }
}
