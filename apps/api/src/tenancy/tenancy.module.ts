import { Global, Module } from '@nestjs/common';
import { TenantDb } from './tenant-db.service';

@Global()
@Module({
  providers: [TenantDb],
  exports: [TenantDb],
})
export class TenancyModule {}
