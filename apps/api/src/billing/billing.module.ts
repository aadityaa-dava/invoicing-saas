import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Env } from '../config/env';
import { TenancyModule } from '../tenancy/tenancy.module';
import { InvoicePaymentsController } from './invoice-payments.controller';
import { InvoicePaymentsService } from './invoice-payments.service';
import { StripeApiGateway } from './stripe-api.gateway';
import { STRIPE_GATEWAY, type StripeGateway } from './stripe.gateway';
import { UnconfiguredStripeGateway } from './unconfigured-stripe.gateway';

@Module({
  imports: [TenancyModule],
  controllers: [InvoicePaymentsController],
  providers: [
    InvoicePaymentsService,
    {
      provide: STRIPE_GATEWAY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): StripeGateway => {
        const key = config.get('STRIPE_SECRET_KEY', { infer: true });
        if (!key) return new UnconfiguredStripeGateway();
        return new StripeApiGateway(
          new Stripe(key, { maxNetworkRetries: 2 }),
          config.get('STRIPE_WEBHOOK_SECRET', { infer: true }),
        );
      },
    },
  ],
  exports: [STRIPE_GATEWAY],
})
export class BillingModule {}
