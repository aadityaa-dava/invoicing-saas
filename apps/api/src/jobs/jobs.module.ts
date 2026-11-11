import { Module } from '@nestjs/common';
import { OverdueService } from './overdue.service';

@Module({
  providers: [OverdueService],
  exports: [OverdueService],
})
export class JobsModule {}
