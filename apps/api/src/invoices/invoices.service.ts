import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { InvoiceStatus, Prisma } from '../generated/prisma/client';
import { TenantDb, type TenantTx } from '../tenancy/tenant-db.service';
import type {
  CreateInvoiceDto,
  ListInvoicesQuery,
  UpdateInvoiceDto,
} from './invoices.dto';
import { computeLine, computeTotals, MoneyError } from './money';

type LineInput = CreateInvoiceDto['lineItems'][number];
type InvoiceWithLines = Prisma.InvoiceGetPayload<{
  include: { lineItems: true };
}>;
type InvoiceRow = Prisma.InvoiceGetPayload<object>;

const toDate = (v: string) => new Date(`${v}T00:00:00.000Z`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const notFound = () => new NotFoundException({ code: 'invoice_not_found' });
const notDraft = () => new ConflictException({ code: 'invoice_not_draft' });

// API shape. Amounts are plain integers (cents): the caps in money.ts keep
// every value below Number.MAX_SAFE_INTEGER, so no precision is lost.
function toSummary(inv: InvoiceRow) {
  return {
    id: inv.id,
    clientId: inv.clientId,
    number: inv.number,
    status: inv.status.toLowerCase(),
    currency: inv.currency,
    issueDate: isoDay(inv.issueDate),
    dueDate: isoDay(inv.dueDate),
    subtotalCents: Number(inv.subtotalCents),
    taxCents: Number(inv.taxCents),
    totalCents: Number(inv.totalCents),
    sentAt: inv.sentAt,
    paidAt: inv.paidAt,
    voidedAt: inv.voidedAt,
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
  };
}

function toApi(inv: InvoiceWithLines) {
  return {
    ...toSummary(inv),
    lineItems: [...inv.lineItems]
      .sort((a, b) => a.position - b.position)
      .map((l) => ({
        id: l.id,
        position: l.position,
        description: l.description,
        quantity: l.quantity.toFixed(),
        unitPriceCents: Number(l.unitPriceCents),
        taxRateBps: l.taxRateBps,
        lineTotalCents: Number(l.lineTotalCents),
        lineTaxCents: Number(l.lineTaxCents),
      })),
  };
}

@Injectable()
export class InvoicesService {
  constructor(private readonly tenantDb: TenantDb) {}

  create(userId: string, orgId: string, dto: CreateInvoiceDto) {
    const { lines, totals } = this.computeLines(dto.lineItems);
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      await this.assertClient(tx, dto.clientId);
      const invoice = await tx.invoice.create({
        data: {
          orgId,
          clientId: dto.clientId,
          currency: dto.currency ?? 'USD',
          issueDate: toDate(dto.issueDate),
          dueDate: toDate(dto.dueDate),
          subtotalCents: totals.subtotalCents,
          taxCents: totals.taxCents,
          totalCents: totals.totalCents,
        },
        select: { id: true },
      });
      await tx.invoiceLineItem.createMany({
        data: this.lineRows(orgId, invoice.id, lines),
      });
      return toApi(await this.load(tx, invoice.id));
    });
  }

  // Capped for now; real pagination arrives in Phase 9.
  list(userId: string, orgId: string, query: ListInvoicesQuery) {
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      const rows = await tx.invoice.findMany({
        where: {
          deletedAt: null,
          ...(query.status
            ? { status: query.status.toUpperCase() as InvoiceStatus }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return rows.map(toSummary);
    });
  }

  get(userId: string, orgId: string, id: string) {
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id, deletedAt: null },
        include: { lineItems: true },
      });
      if (!invoice) throw notFound();
      return toApi(invoice);
    });
  }

  update(userId: string, orgId: string, id: string, dto: UpdateInvoiceDto) {
    const computed = dto.lineItems
      ? this.computeLines(dto.lineItems)
      : undefined;
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      const current = await this.lockDraft(tx, id);

      const issueDate = dto.issueDate ?? current.issueDate;
      const dueDate = dto.dueDate ?? current.dueDate;
      if (dueDate < issueDate) {
        throw new BadRequestException({ code: 'due_before_issue' });
      }
      if (dto.clientId) await this.assertClient(tx, dto.clientId);

      const data: Prisma.InvoiceUncheckedUpdateInput = {
        ...(dto.clientId ? { clientId: dto.clientId } : {}),
        ...(dto.currency ? { currency: dto.currency } : {}),
        issueDate: toDate(issueDate),
        dueDate: toDate(dueDate),
      };
      if (computed) {
        data.subtotalCents = computed.totals.subtotalCents;
        data.taxCents = computed.totals.taxCents;
        data.totalCents = computed.totals.totalCents;
        await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });
        await tx.invoiceLineItem.createMany({
          data: this.lineRows(orgId, id, computed.lines),
        });
      }
      await tx.invoice.update({ where: { id }, data });
      return toApi(await this.load(tx, id));
    });
  }

  // Soft delete, drafts only: issued invoices are voided, never deleted.
  async remove(userId: string, orgId: string, id: string): Promise<void> {
    await this.tenantDb.run({ userId, orgId }, async (tx) => {
      await this.lockDraft(tx, id);
      await tx.invoice.update({ where: { id }, data: { deletedAt: new Date() } });
    });
  }

  // Draft -> sent. Assigns the next number from the organization's counter.
  // Both locks (the invoice row, then the counter row) are held until commit,
  // so concurrent sends are serialized. The counter increment commits or rolls
  // back together with the invoice update: numbers are unique AND gapless.
  send(userId: string, orgId: string, id: string) {
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      const current = await this.lockInvoice(tx, id);
      if (current.status !== 'draft') throw notDraft();

      // Creates the counter on the first send, increments it afterwards.
      // The first call stores 2 and returns 1.
      const counter = await tx.$queryRaw<{ assigned: number }[]>`
        INSERT INTO invoice_counters (org_id, next_number)
        VALUES (${orgId}::uuid, 2)
        ON CONFLICT (org_id)
        DO UPDATE SET next_number = invoice_counters.next_number + 1
        RETURNING next_number - 1 AS assigned`;
      const number = `INV-${String(counter[0].assigned).padStart(6, '0')}`;

      await tx.invoice.update({
        where: { id },
        data: { status: 'SENT', number, sentAt: new Date() },
      });
      return toApi(await this.load(tx, id));
    });
  }

  // draft | sent | overdue -> void. A paid or already voided invoice cannot be.
  voidInvoice(userId: string, orgId: string, id: string) {
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      const current = await this.lockInvoice(tx, id);
      if (!['draft', 'sent', 'overdue'].includes(current.status)) {
        throw new ConflictException({ code: 'invoice_not_voidable' });
      }
      await tx.invoice.update({
        where: { id },
        data: { status: 'VOID', voidedAt: new Date() },
      });
      return toApi(await this.load(tx, id));
    });
  }

  // Everything the PDF needs, read in one transaction. The client is looked up
  // even if it was soft-deleted since: an issued invoice must stay printable.
  getPdfData(userId: string, orgId: string, id: string) {
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id, deletedAt: null },
        include: { lineItems: true },
      });
      if (!invoice) throw notFound();
      const org = await tx.organization.findUnique({
        where: { id: orgId },
        select: { name: true },
      });
      const client = await tx.client.findFirst({
        where: { id: invoice.clientId },
        select: { name: true, email: true, billingAddress: true, taxId: true },
      });
      return {
        organizationName: org?.name ?? '',
        client,
        invoice: toApi(invoice),
      };
    });
  }

  // --- helpers ------------------------------------------------------------

  private computeLines(items: readonly LineInput[]) {
    try {
      const lines = items.map((item, index) => {
        const unitPriceCents = BigInt(item.unitPriceCents);
        const taxRateBps = item.taxRateBps ?? 0;
        const amounts = computeLine({
          quantity: item.quantity,
          unitPriceCents,
          taxRateBps,
        });
        return {
          position: index + 1,
          description: item.description,
          quantity: item.quantity,
          unitPriceCents,
          taxRateBps,
          ...amounts,
        };
      });
      return { lines, totals: computeTotals(lines) };
    } catch (e) {
      if (e instanceof MoneyError) {
        throw new BadRequestException({ code: e.code });
      }
      throw e;
    }
  }

  private lineRows(
    orgId: string,
    invoiceId: string,
    lines: ReturnType<InvoicesService['computeLines']>['lines'],
  ) {
    return lines.map((l) => ({ orgId, invoiceId, ...l }));
  }

  // Under RLS another tenant's client is invisible, so it reads as unknown.
  // The composite foreign key is the backstop if this check were skipped.
  private async assertClient(tx: TenantTx, clientId: string) {
    const client = await tx.client.findFirst({
      where: { id: clientId, deletedAt: null },
      select: { id: true },
    });
    if (!client) throw new BadRequestException({ code: 'unknown_client' });
  }

  private load(tx: TenantTx, id: string) {
    return tx.invoice.findFirstOrThrow({
      where: { id },
      include: { lineItems: true },
    });
  }

  // Locks the invoice row until the transaction ends, so an edit, a send and a
  // void can never interleave. Returns its current state.
  private async lockInvoice(tx: TenantTx, id: string) {
    const rows = await tx.$queryRaw<
      { status: string; issue_date: string; due_date: string }[]
    >`SELECT status::text AS status, issue_date::text AS issue_date,
             due_date::text AS due_date
      FROM invoices
      WHERE id = ${id}::uuid AND deleted_at IS NULL
      FOR UPDATE`;
    const row = rows[0];
    if (!row) throw notFound();
    return {
      status: row.status,
      issueDate: row.issue_date,
      dueDate: row.due_date,
    };
  }

  private async lockDraft(tx: TenantTx, id: string) {
    const row = await this.lockInvoice(tx, id);
    if (row.status !== 'draft') throw notDraft();
    return row;
  }
}
