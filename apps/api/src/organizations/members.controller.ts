import { Controller, Get } from '@nestjs/common';
import type { AuthUser, OrgMembership } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { CurrentMembership } from '../tenancy/current-membership.decorator';
import { MembersService } from './members.service';

@Controller('orgs/:orgId/members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @CurrentMembership() m: OrgMembership) {
    return this.members.list(user.id, m.orgId);
  }
}
