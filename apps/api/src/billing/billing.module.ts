import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Env } from '../config/env';
import { PrismaModule } from '../prisma/prisma.module';
import { InvoicePaymentsController } from './invoice-payments.controller';
import { InvoicePaymentsService } from './invoice-payments.service';
import { OrgBillingController } from './org-billing.controller';
import { PlanService } from './plan.service';
import { OrgBillingService } from './org-billing.service';
import { StripeApiGateway } from './stripe-api.gateway';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeWebhookService } from './stripe-webhook.service';
import { STRIPE_GATEWAY, type StripeGateway } from './stripe.gateway';
import { UnconfiguredStripeGateway } from './unconfigured-stripe.gateway';

@Module({
  // Do not import TenancyModule here. It is global, and it registers the
  // membership and permission guards. Importing it from a module that loads
  // before AuthModule would register those guards ahead of authentication.
  imports: [PrismaModule],
  controllers: [
    InvoicePaymentsController,
    StripeWebhookController,
    OrgBillingController,
  ],
  providers: [
    InvoicePaymentsService,
    OrgBillingService,
    PlanService,
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
  exports: [STRIPE_GATEWAY, PlanService],
})
export class BillingModule {}
