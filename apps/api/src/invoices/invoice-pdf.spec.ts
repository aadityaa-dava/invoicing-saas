import {
  pdfLabels,
  renderInvoicePdf,
  type InvoicePdfData,
} from './invoice-pdf';

const line = (i: number, description = `Item ${i}`) => ({
  description,
  quantity: '1',
  unitPriceCents: 1000,
  taxRateBps: 825,
  lineTotalCents: 1000,
});

const sample = (over: Partial<InvoicePdfData['invoice']> = {}): InvoicePdfData => ({
  organizationName: 'Acme Ltd',
  client: {
    name: 'Globex',
    email: 'billing@globex.test',
    billingAddress: '1 Main Street\nSpringfield',
    taxId: 'GB123',
  },
  invoice: {
    id: '0198f3a2-aaaa-7bbb-8ccc-123456789abc',
    number: 'INV-000001',
    status: 'sent',
    currency: 'USD',
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    subtotalCents: 1000,
    taxCents: 83,
    totalCents: 1083,
    lineItems: [line(1)],
    ...over,
  },
});

const pagesOf = (pdf: Buffer) =>
  (pdf.toString('latin1').match(/\/Type \/Page(?!s)/g) ?? []).length;

describe('pdfLabels', () => {
  it('uses the number for an issued invoice', () => {
    expect(pdfLabels(sample().invoice)).toEqual({
      heading: 'INV-000001',
      watermark: null,
      filename: 'INV-000001.pdf',
    });
  });

  it('stamps a draft, shows no number, and names the file after the draft', () => {
    const labels = pdfLabels(sample({ number: null, status: 'draft' }).invoice);
    expect(labels).toEqual({
      heading: 'DRAFT',
      watermark: 'DRAFT',
      filename: 'draft-0198f3a2.pdf',
    });
  });

  it('stamps a voided invoice and keeps its number', () => {
    const labels = pdfLabels(sample({ status: 'void' }).invoice);
    expect(labels.heading).toBe('INV-000001');
    expect(labels.watermark).toBe('VOID');
  });

  it('does not stamp sent, paid or overdue invoices', () => {
    for (const status of ['sent', 'paid', 'overdue']) {
      expect(pdfLabels(sample({ status }).invoice).watermark).toBeNull();
    }
  });
});

describe('renderInvoicePdf', () => {
  it('produces a well-formed single-page PDF', async () => {
    const pdf = await renderInvoicePdf(sample());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.subarray(-16).toString()).toContain('%%EOF');
    expect(pagesOf(pdf)).toBe(1);
  });

  it('renders every supported currency', async () => {
    for (const currency of ['USD', 'EUR', 'GBP', 'CAD', 'AUD']) {
      const pdf = await renderInvoicePdf(sample({ currency }));
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    }
  });

  it('renders drafts and voided invoices', async () => {
    const draft = await renderInvoicePdf(sample({ number: null, status: 'draft' }));
    const voided = await renderInvoicePdf(sample({ status: 'void' }));
    expect(draft.subarray(0, 5).toString()).toBe('%PDF-');
    expect(voided.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pagesOf(draft)).toBe(1);
  });

  it('flows a long invoice onto more pages', async () => {
    const many = Array.from({ length: 150 }, (_, i) => line(i + 1));
    const pdf = await renderInvoicePdf(sample({ lineItems: many }));
    expect(pagesOf(pdf)).toBeGreaterThan(2);
  });

  it('handles a missing client, long text and unusual characters', async () => {
    const data = sample({
      lineItems: [
        line(1, 'A very long description that has to wrap. '.repeat(20)),
        line(2, 'Café — naïve 日本語 ☕ <b>&amp;</b>'),
      ],
    });
    data.client = null;
    const pdf = await renderInvoicePdf(data);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

// Optional visual review. Run with:
//   SAMPLE_PDF_DIR=/tmp/invoice-samples pnpm --filter api test -- invoice-pdf
import { mkdirSync, writeFileSync } from 'node:fs';

const sampleDir = process.env.SAMPLE_PDF_DIR;
(sampleDir ? describe : describe.skip)('sample output for visual review', () => {
  it('writes sample PDFs', async () => {
    const dir = sampleDir as string;
    mkdirSync(dir, { recursive: true });

    const realistic = [
      {
        description: 'Website redesign: discovery workshop and requirements',
        quantity: '1.5',
        unitPriceCents: 15000,
        taxRateBps: 825,
        lineTotalCents: 22500,
      },
      {
        description: 'Hosting and maintenance (12 months)',
        quantity: '12',
        unitPriceCents: 2500,
        taxRateBps: 0,
        lineTotalCents: 30000,
      },
      {
        description:
          'Custom integration with the customer billing system, including testing, documentation and two rounds of revisions',
        quantity: '1',
        unitPriceCents: 4999,
        taxRateBps: 1000,
        lineTotalCents: 4999,
      },
    ];
    const base = {
      lineItems: realistic,
      subtotalCents: 57499,
      taxCents: 2356,
      totalCents: 59855,
    };

    const many = Array.from({ length: 60 }, (_, i) => line(i + 1));
    const files: [string, InvoicePdfData][] = [
      ['sent.pdf', sample({ ...base })],
      ['draft.pdf', sample({ ...base, number: null, status: 'draft' })],
      ['void.pdf', sample({ ...base, status: 'void' })],
      ['long.pdf', sample({ lineItems: many, subtotalCents: 60000, taxCents: 4950, totalCents: 64950 })],
    ];
    for (const [name, data] of files) {
      writeFileSync(`${dir}/${name}`, await renderInvoicePdf(data));
    }
  });
});
