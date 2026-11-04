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
  clientIdParamSchema,
  createClientSchema,
  updateClientSchema,
  type CreateClientDto,
  type UpdateClientDto,
} from './clients.dto';
import { ClientsService } from './clients.service';

const idPipe = new ZodValidationPipe(clientIdParamSchema);

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

  @Get(':id')
  @RequirePermission('client:read')
  get(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Param('id', idPipe) id: string,
  ) {
    return this.clients.get(user.id, m.orgId, id);
  }

  @Patch(':id')
  @RequirePermission('client:write')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateClientSchema)) body: UpdateClientDto,
  ) {
    return this.clients.update(user.id, m.orgId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('client:delete')
  async remove(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Param('id', idPipe) id: string,
  ): Promise<void> {
    await this.clients.remove(user.id, m.orgId, id);
  }
}
