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
  createInvoiceSchema,
  invoiceIdParamSchema,
  listInvoicesQuerySchema,
  updateInvoiceSchema,
  type CreateInvoiceDto,
  type ListInvoicesQuery,
  type UpdateInvoiceDto,
} from './invoices.dto';
import { InvoicesService } from './invoices.service';

const idPipe = new ZodValidationPipe(invoiceIdParamSchema);

@Controller('orgs/:orgId/invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post()
  @RequirePermission('invoice:write')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Body(new ZodValidationPipe(createInvoiceSchema)) body: CreateInvoiceDto,
  ) {
    return this.invoices.create(user.id, m.orgId, body);
  }

  @Get()
  @RequirePermission('invoice:read')
  list(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Query(new ZodValidationPipe(listInvoicesQuerySchema))
    query: ListInvoicesQuery,
  ) {
    return this.invoices.list(user.id, m.orgId, query);
  }

  @Get(':id')
  @RequirePermission('invoice:read')
  get(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Param('id', idPipe) id: string,
  ) {
    return this.invoices.get(user.id, m.orgId, id);
  }

  @Patch(':id')
  @RequirePermission('invoice:write')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateInvoiceSchema)) body: UpdateInvoiceDto,
  ) {
    return this.invoices.update(user.id, m.orgId, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('invoice:write')
  async remove(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Param('id', idPipe) id: string,
  ): Promise<void> {
    await this.invoices.remove(user.id, m.orgId, id);
  }

  @Post(':id/send')
  @HttpCode(200)
  @RequirePermission('invoice:send')
  send(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Param('id', idPipe) id: string,
  ) {
    return this.invoices.send(user.id, m.orgId, id);
  }

  @Post(':id/void')
  @HttpCode(200)
  @RequirePermission('invoice:void')
  voidInvoice(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Param('id', idPipe) id: string,
  ) {
    return this.invoices.voidInvoice(user.id, m.orgId, id);
  }
}
