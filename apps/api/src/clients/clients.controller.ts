import { Body, Controller, Get, Post } from '@nestjs/common';
import type { AuthUser, OrgMembership } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentMembership } from '../tenancy/current-membership.decorator';
import { createClientSchema, type CreateClientDto } from './clients.dto';
import { ClientsService } from './clients.service';

// :orgId in the path makes OrgMembershipGuard and PermissionsGuard run.
@Controller('orgs/:orgId/clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Post()
  @RequirePermission('client:write')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Body(new ZodValidationPipe(createClientSchema)) body: CreateClientDto,
  ) {
    return this.clients.create(user.id, m.orgId, body);
  }

  @Get()
  @RequirePermission('client:read')
  list(@CurrentUser() user: AuthUser, @CurrentMembership() m: OrgMembership) {
    return this.clients.list(user.id, m.orgId);
  }
}
