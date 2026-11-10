export const MAIL_JOB_NAME = 'send';
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export type SimpleMailJob =
  | { kind: 'verify-email'; to: string; token: string }
  | { kind: 'password-reset'; to: string; token: string }
  | { kind: 'account-exists'; to: string };

// Carries ids only: the worker loads current data under row-level security,
// so no invoice content is stored in Redis and a retry always sends fresh data.
export type InvoiceSentJob = {
  kind: 'invoice-sent';
  orgId: string;
  invoiceId: string;
};

export type MailJob = SimpleMailJob | InvoiceSentJob;

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}

export interface MailTransport {
  sendMail(message: MailMessage): Promise<unknown>;
}
