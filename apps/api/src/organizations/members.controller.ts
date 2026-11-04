import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { AuthUser, OrgMembership } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentMembership } from '../tenancy/current-membership.decorator';
import {
  addMemberSchema,
  changeRoleSchema,
  userIdParamSchema,
  type AddMemberDto,
  type ChangeRoleDto,
} from './members.dto';
import { MembersService, type Actor } from './members.service';

const actorOf = (user: AuthUser, m: OrgMembership): Actor => ({
  userId: user.id,
  orgId: m.orgId,
  role: m.role,
});

@Controller('orgs/:orgId/members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermission('member:read')
  list(@CurrentUser() user: AuthUser, @CurrentMembership() m: OrgMembership) {
    return this.members.list(user.id, m.orgId);
  }

  @Post()
  @RequirePermission('member:manage')
  add(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Body(new ZodValidationPipe(addMemberSchema)) body: AddMemberDto,
  ) {
    return this.members.add(actorOf(user, m), body);
  }

  @Patch(':userId')
  @RequirePermission('member:manage')
  changeRole(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Param('userId', new ZodValidationPipe(userIdParamSchema)) userId: string,
    @Body(new ZodValidationPipe(changeRoleSchema)) body: ChangeRoleDto,
  ) {
    return this.members.changeRole(actorOf(user, m), userId, body.role);
  }

  @Delete(':userId')
  @HttpCode(204)
  @RequirePermission('member:manage')
  async remove(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Param('userId', new ZodValidationPipe(userIdParamSchema)) userId: string,
  ): Promise<void> {
    await this.members.remove(actorOf(user, m), userId);
  }
}
