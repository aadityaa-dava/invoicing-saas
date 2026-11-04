import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { OrgMembershipGuard } from './org-membership.guard';
import { TenantDb } from './tenant-db.service';

// Imported after AuthModule in AppModule, so JwtAuthGuard runs first and
// req.user is set. The guard also throws 401 itself if it is not.
@Global()
@Module({
  providers: [TenantDb, { provide: APP_GUARD, useClass: OrgMembershipGuard }],
  exports: [TenantDb],
})
export class TenancyModule {}
