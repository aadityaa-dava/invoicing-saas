import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { AuthUser, OrgMembership } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentMembership } from '../tenancy/current-membership.decorator';
import {
  createRecurringSchema,
  listRecurringQuerySchema,
  recurringIdParamSchema,
  updateRecurringSchema,
  type CreateRecurringDto,
  type ListRecurringQuery,
  type UpdateRecurringDto,
} from './recurring.dto';
import { RecurringService } from './recurring.service';

const idPipe = new ZodValidationPipe(recurringIdParamSchema);

@Controller('orgs/:orgId/recurring-invoices')
export class RecurringController {
  constructor(private readonly recurring: RecurringService) {}

  @Post()
  @RequirePermission('recurring:manage')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Body(new ZodValidationPipe(createRecurringSchema))
    body: CreateRecurringDto,
  ) {
    return this.recurring.create(user.id, m.orgId, body);
  }

  @Get()
  @RequirePermission('invoice:read')
  list(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Query(new ZodValidationPipe(listRecurringQuerySchema))
    query: ListRecurringQuery,
  ) {
    return this.recurring.list(user.id, m.orgId, query);
  }

  @Get(':id')
  @RequirePermission('invoice:read')
  get(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Param('id', idPipe) id: string,
  ) {
    return this.recurring.get(user.id, m.orgId, id);
  }

  @Patch(':id')
  @RequirePermission('recurring:manage')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateRecurringSchema))
    body: UpdateRecurringDto,
  ) {
    return this.recurring.update(user.id, m.orgId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('recurring:manage')
  async remove(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Param('id', idPipe) id: string,
  ): Promise<void> {
    await this.recurring.remove(user.id, m.orgId, id);
  }
}
