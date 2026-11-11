import { Module } from '@nestjs/common';
import { InvoicesModule } from '../invoices/invoices.module';
import { OverdueService } from './overdue.service';
import { RecurringGenerationService } from './recurring-generation.service';

@Module({
  imports: [InvoicesModule],
  providers: [OverdueService, RecurringGenerationService],
  exports: [OverdueService, RecurringGenerationService],
})
export class JobsModule {}
