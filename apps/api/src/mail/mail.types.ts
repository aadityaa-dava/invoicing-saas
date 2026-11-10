export const MAIL_JOB_NAME = 'send';
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

export type MailJob =
  | { kind: 'verify-email'; to: string; token: string }
  | { kind: 'password-reset'; to: string; token: string }
  | { kind: 'account-exists'; to: string };

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  sendMail(message: MailMessage): Promise<unknown>;
}
