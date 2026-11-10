import type { InvoicePdfData } from '../invoices/invoice-pdf';
import { buildInvoiceEmail } from './invoice-email';

const data = (email: string | null): InvoicePdfData => ({
  organizationName: 'Acme Studio',
  client: { name: 'Globex', email, billingAddress: null, taxId: null },
  invoice: {
    id: 'inv-1',
    number: 'INV-000007',
    status: 'sent',
    currency: 'USD',
    issueDate: '2026-11-01',
    dueDate: '2026-11-30',
    subtotalCents: 100000,
    taxCents: 8000,
    totalCents: 108000,
    lineItems: [],
  },
});

describe('buildInvoiceEmail', () => {
  const pdf = Buffer.from('%PDF-test');

  it('addresses the client and attaches the PDF', () => {
    const mail = buildInvoiceEmail(data('billing@globex.test'), pdf);
    expect(mail).not.toBeNull();
    expect(mail?.to).toBe('billing@globex.test');
    expect(mail?.subject).toBe('Invoice INV-000007 from Acme Studio');
    expect(mail?.text).toContain('$1,080.00');
    expect(mail?.text).toContain('2026-11-30');
    expect(mail?.attachments).toEqual([
      {
        filename: 'INV-000007.pdf',
        content: pdf,
        contentType: 'application/pdf',
      },
    ]);
  });

  it('returns null when the client has no email address', () => {
    expect(buildInvoiceEmail(data(null), pdf)).toBeNull();
  });
});
