import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { StripeWebhookService } from './stripe-webhook.service';

// Public on purpose: Stripe cannot sign in. The signature over the raw body is
// the only credential, and it is checked before anything else happens.
@Public()
@Controller('webhooks')
export class StripeWebhookController {
  constructor(private readonly webhooks: StripeWebhookService) {}

  @Post('stripe')
  @HttpCode(200)
  handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ) {
    return this.webhooks.handle(req.rawBody, signature);
  }
}
