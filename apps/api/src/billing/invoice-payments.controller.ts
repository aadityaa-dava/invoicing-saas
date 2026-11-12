import { Controller, Param, Post } from '@nestjs/common';
import type { AuthUser, OrgMembership } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { invoiceIdParamSchema } from '../invoices/invoices.dto';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentMembership } from '../tenancy/current-membership.decorator';
import { InvoicePaymentsService } from './invoice-payments.service';

const idPipe = new ZodValidationPipe(invoiceIdParamSchema);

@Controller('orgs/:orgId/invoices')
export class InvoicePaymentsController {
  constructor(private readonly payments: InvoicePaymentsService) {}

  @Post(':id/payment-link')
  @RequirePermission('invoice:send')
  paymentLink(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
    @Param('id', idPipe) id: string,
  ) {
    return this.payments.createPaymentLink(user.id, m.orgId, id);
  }
}
