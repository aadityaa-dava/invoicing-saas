import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { OrgMembershipGuard } from './org-membership.guard';
import { TenantDb } from './tenant-db.service';

// Imported after AuthModule in AppModule, so JwtAuthGuard runs first.
// Order within this list matters: membership must be resolved before
// permissions are checked.
@Global()
@Module({
  providers: [
    TenantDb,
    { provide: APP_GUARD, useClass: OrgMembershipGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [TenantDb],
})
export class TenancyModule {}
