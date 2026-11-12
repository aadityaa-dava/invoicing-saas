import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Env } from '../config/env';
import { PrismaModule } from '../prisma/prisma.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { InvoicePaymentsController } from './invoice-payments.controller';
import { InvoicePaymentsService } from './invoice-payments.service';
import { StripeApiGateway } from './stripe-api.gateway';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';
import { STRIPE_GATEWAY, type StripeGateway } from './stripe.gateway';
import { UnconfiguredStripeGateway } from './unconfigured-stripe.gateway';

@Module({
  imports: [TenancyModule, PrismaModule],
  controllers: [InvoicePaymentsController, StripeWebhookController],
  providers: [
    InvoicePaymentsService,
    StripeWebhookService,
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
