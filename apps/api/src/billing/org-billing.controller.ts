import { Controller, Get, Post } from '@nestjs/common';
import type { AuthUser, OrgMembership } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentMembership } from '../tenancy/current-membership.decorator';
import { OrgBillingService } from './org-billing.service';

// Owner only: billing:manage is not granted to any other role.
@Controller('orgs/:orgId/billing')
export class OrgBillingController {
  constructor(private readonly billing: OrgBillingService) {}

  @Get()
  @RequirePermission('billing:manage')
  get(@CurrentUser() user: AuthUser, @CurrentMembership() m: OrgMembership) {
    return this.billing.get(user.id, m.orgId);
  }

  @Post('checkout-session')
  @RequirePermission('billing:manage')
  checkout(
    @CurrentUser() user: AuthUser,
    @CurrentMembership() m: OrgMembership,
  ) {
    return this.billing.createCheckoutSession(user.id, m.orgId);
  }

  @Post('portal-session')
  @RequirePermission('billing:manage')
  portal(@CurrentUser() user: AuthUser, @CurrentMembership() m: OrgMembership) {
    return this.billing.createPortalSession(user.id, m.orgId);
  }
}
