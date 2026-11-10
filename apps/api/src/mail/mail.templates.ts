import type { SimpleMailJob } from './mail.types';

export interface RenderedMail {
  to: string;
  subject: string;
  text: string;
}

export function renderMail(job: SimpleMailJob, webUrl: string): RenderedMail {
  switch (job.kind) {
    case 'verify-email':
      return {
        to: job.to,
        subject: 'Verify your email address',
        text: `Confirm your email address to finish setting up your account:\n\n${webUrl}/verify-email?token=${job.token}\n\nIf you did not create an account, you can ignore this message.`,
      };
    case 'password-reset':
      return {
        to: job.to,
        subject: 'Reset your password',
        text: `Use this link to choose a new password:\n\n${webUrl}/reset-password?token=${job.token}\n\nIf you did not ask for this, you can ignore this message.`,
      };
    case 'account-exists':
      return {
        to: job.to,
        subject: 'You already have an account',
        text: `Someone tried to sign up with this address, but an account already exists.\n\nYou can sign in or reset your password at ${webUrl}/login.\n\nIf this was not you, no action is needed.`,
      };
    default: {
      const unreachable: never = job;
      throw new Error(`Unknown mail job: ${JSON.stringify(unreachable)}`);
    }
  }
}
