import PDFDocument from 'pdfkit';
import { formatMoney } from './format-money';

export interface InvoicePdfData {
  organizationName: string;
  client: {
    name: string;
    email: string | null;
    billingAddress: string | null;
    taxId: string | null;
  } | null;
  invoice: {
    id: string;
    number: string | null;
    status: string;
    currency: string;
    issueDate: string;
    dueDate: string;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    lineItems: {
      description: string;
      quantity: string;
      unitPriceCents: number;
      taxRateBps: number;
      lineTotalCents: number;
    }[];
  };
}

// The labelling rules, kept as a pure function so they can be tested without
// reading text back out of a PDF. A draft has no number: it is stamped DRAFT
// everywhere so nobody can mistake it for an issued invoice.
export function pdfLabels(
  invoice: Pick<InvoicePdfData['invoice'], 'id' | 'number' | 'status'>,
) {
  const status = invoice.status.toUpperCase();
  return {
    heading: invoice.number ?? status,
    watermark: status === 'DRAFT' || status === 'VOID' ? status : null,
    filename: invoice.number
      ? `${invoice.number}.pdf`
      : `${invoice.status}-${invoice.id.slice(0, 8)}.pdf`,
  };
}

const MARGIN = 50;
const RESERVED_BOTTOM = 90; // room kept free for the totals block
const COL = {
  desc: { x: 50, w: 230 },
  qty: { x: 285, w: 50 },
  unit: { x: 340, w: 80 },
  tax: { x: 425, w: 45 },
  amount: { x: 475, w: 70 },
};

// 825 basis points -> "8.25%", integer math only.
const formatBps = (bps: number) =>
  `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const labels = pdfLabels(data.invoice);
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      info: {
        Title: `Invoice ${labels.heading}`,
        Author: data.organizationName,
        Creator: 'Invoicing',
        Producer: 'Invoicing',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      if (labels.watermark) {
        stampWatermark(doc, labels.watermark);
        doc.on('pageAdded', () => {
          stampWatermark(doc, labels.watermark as string);
        });
      }
      draw(doc, data, labels.heading);
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function stampWatermark(doc: PDFKit.PDFDocument, label: string) {
  doc.save();
  doc.rotate(-45, { origin: [297, 420] });
  doc
    .font('Helvetica-Bold')
    .fontSize(120)
    .fillColor('#eeeeee')
    .text(label, 60, 330, { width: 480, align: 'center', lineBreak: false });
  doc.restore();
  doc.fillColor('#111111');
  doc.x = MARGIN;
  doc.y = MARGIN;
}

function draw(doc: PDFKit.PDFDocument, data: InvoicePdfData, heading: string) {
  const { invoice, client } = data;
  const money = (cents: number) => formatMoney(BigInt(cents), invoice.currency);

  // Header: organization on the left, document title and number on the right.
  doc
    .fillColor('#111111')
    .font('Helvetica-Bold')
    .fontSize(20)
    .text(data.organizationName, MARGIN, MARGIN, { width: 280 });
  doc
    .font('Helvetica-Bold')
    .fontSize(24)
    .text('INVOICE', 350, MARGIN, { width: 195, align: 'right' });
  doc
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#444444')
    .text(heading, 350, MARGIN + 30, { width: 195, align: 'right' });

  // Bill-to block (left) and dates (right).
  const blockY = 130;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#888888');
  doc.text('BILL TO', MARGIN, blockY);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111111');
  doc.text(client?.name ?? 'Client unavailable', MARGIN, doc.y + 2, {
    width: 260,
  });
  doc.font('Helvetica').fontSize(10).fillColor('#444444');
  if (client?.billingAddress) doc.text(client.billingAddress, { width: 260 });
  if (client?.email) doc.text(client.email, { width: 260 });
  if (client?.taxId) doc.text(`Tax ID: ${client.taxId}`, { width: 260 });
  const leftBottom = doc.y;

  const meta: [string, string][] = [
    ['Issue date', invoice.issueDate],
    ['Due date', invoice.dueDate],
    ['Currency', invoice.currency],
    ['Status', capitalize(invoice.status)],
  ];
  let metaY = blockY;
  for (const [label, value] of meta) {
    doc.font('Helvetica').fontSize(10).fillColor('#888888');
    doc.text(label, 350, metaY, { width: 90, lineBreak: false });
    doc.fillColor('#111111');
    doc.text(value, 440, metaY, { width: 105, align: 'right', lineBreak: false });
    metaY += 16;
  }

  // Line item table.
  let y = Math.max(leftBottom, metaY) + 30;
  y = tableHeader(doc, y);
  for (const line of invoice.lineItems) {
    doc.font('Helvetica').fontSize(10);
    const height = Math.max(
      doc.heightOfString(line.description, { width: COL.desc.w }),
      14,
    );
    if (y + height > doc.page.height - MARGIN - RESERVED_BOTTOM) {
      doc.addPage();
      y = tableHeader(doc, MARGIN);
    }
    doc.fillColor('#111111');
    doc.text(line.description, COL.desc.x, y, { width: COL.desc.w });
    cell(doc, line.quantity, COL.qty, y);
    cell(doc, money(line.unitPriceCents), COL.unit, y);
    cell(doc, formatBps(line.taxRateBps), COL.tax, y);
    cell(doc, money(line.lineTotalCents), COL.amount, y);
    y += height + 8;
  }

  // Totals.
  doc
    .moveTo(340, y)
    .lineTo(545, y)
    .strokeColor('#cccccc')
    .lineWidth(0.5)
    .stroke();
  y += 10;
  const totals: [string, number, boolean][] = [
    ['Subtotal', invoice.subtotalCents, false],
    ['Tax', invoice.taxCents, false],
    ['Total', invoice.totalCents, true],
  ];
  for (const [label, cents, bold] of totals) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10);
    doc.fillColor('#111111');
    doc.text(label, 340, y, { width: 130, lineBreak: false });
    cell(doc, money(cents), COL.amount, y);
    y += bold ? 20 : 16;
  }
}

function tableHeader(doc: PDFKit.PDFDocument, y: number): number {
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#888888');
  doc.text('DESCRIPTION', COL.desc.x, y, { width: COL.desc.w, lineBreak: false });
  cell(doc, 'QTY', COL.qty, y);
  cell(doc, 'UNIT PRICE', COL.unit, y);
  cell(doc, 'TAX', COL.tax, y);
  cell(doc, 'AMOUNT', COL.amount, y);
  doc
    .moveTo(MARGIN, y + 14)
    .lineTo(545, y + 14)
    .strokeColor('#cccccc')
    .lineWidth(0.5)
    .stroke();
  return y + 24;
}

function cell(
  doc: PDFKit.PDFDocument,
  value: string,
  col: { x: number; w: number },
  y: number,
) {
  doc.text(value, col.x, y, { width: col.w, align: 'right', lineBreak: false });
}
