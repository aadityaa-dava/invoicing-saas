import type { InvoicePdfData } from '../invoices/invoice-pdf';
import type { MailMessage } from './mail.types';

export type OutgoingMail = Omit<MailMessage, 'from'>;

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
    cents / 100,
  );

// Returns null when there is nobody to send to.
export function buildInvoiceEmail(
  data: InvoicePdfData,
  pdf: Buffer,
): OutgoingMail | null {
  const to = data.client?.email;
  if (!to) return null;
  const { invoice } = data;
  const label = invoice.number ?? 'invoice';
  const org = data.organizationName || 'Your supplier';
  return {
    to,
    subject: `Invoice ${label} from ${org}`,
    text:
      `Hello ${data.client?.name ?? ''},\n\n` +
      `${org} has sent you invoice ${label} for ` +
      `${money(invoice.totalCents, invoice.currency)}, due ${invoice.dueDate}.\n\n` +
      `The invoice is attached as a PDF.`,
    attachments: [
      {
        filename: `${label}.pdf`,
        content: pdf,
        contentType: 'application/pdf',
      },
    ],
  };
}
