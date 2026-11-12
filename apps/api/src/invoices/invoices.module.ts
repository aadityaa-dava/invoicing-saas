import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { MailModule } from '../mail/mail.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

@Module({
  imports: [MailModule, BillingModule],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
