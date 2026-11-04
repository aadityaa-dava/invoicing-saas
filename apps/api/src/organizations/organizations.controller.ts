import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import type { AuthUser, OrgMembership } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  AnyMember,
  RequirePermission,
} from '../rbac/require-permission.decorator';
import { CurrentMembership } from '../tenancy/current-membership.decorator';
import {
  createOrganizationSchema,
  updateOrganizationSchema,
  type CreateOrganizationDto,
  type UpdateOrganizationDto,
} from './organizations.dto';
import { OrganizationsService } from './organizations.service';

@Controller('orgs')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createOrganizationSchema))
    body: CreateOrganizationDto,
  ) {
    return this.orgs.create(user.id, body.name);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.orgs.listMine(user.id);
  }

  // Any member may read their own organization.
  @Get(':orgId')
  @AnyMember()
  get(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() membership: OrgMembership,
  ) {
    return this.orgs.get(user.id, membership.orgId, membership.role);
  }

  @Patch(':orgId')
  @RequirePermission('org:update')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() membership: OrgMembership,
    @Body(new ZodValidationPipe(updateOrganizationSchema))
    body: UpdateOrganizationDto,
  ) {
    return this.orgs.update(user.id, membership.orgId, body.name);
  }
}
