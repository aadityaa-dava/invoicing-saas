import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import type { Env } from '../config/env';
import { MailProcessor } from './mail.processor';
import { MailService } from './mail.service';
import { MAIL_TRANSPORT, type MailTransport } from './mail.types';

@Module({
  providers: [
    MailService,
    MailProcessor,
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): MailTransport => {
        const user = config.get('SMTP_USER', { infer: true });
        const transporter = createTransport({
          host: config.get('SMTP_HOST', { infer: true }),
          port: config.get('SMTP_PORT', { infer: true }),
          secure: config.get('SMTP_SECURE', { infer: true }),
          auth: user
            ? { user, pass: config.get('SMTP_PASSWORD', { infer: true }) }
            : undefined,
        });
        return { sendMail: (message) => transporter.sendMail(message) };
      },
    },
  ],
  exports: [MailService],
})
export class MailModule {}
