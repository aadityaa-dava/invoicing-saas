import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isoDay, todayUtc, toDate } from '../common/dates';
import type { Prisma, RecurringFrequency } from '../generated/prisma/client';
import { computeInvoiceLines } from '../invoices/invoice-lines';
import { TenantDb, type TenantTx } from '../tenancy/tenant-db.service';
import type {
  CreateRecurringDto,
  ListRecurringQuery,
  UpdateRecurringDto,
} from './recurring.dto';
import {
  firstRunOnOrAfter,
  runDateOrNull,
  type Frequency,
} from './recurring-schedule';

type TemplateWithLines = Prisma.RecurringTemplateGetPayload<{
  include: { lineItems: true };
}>;

const notFound = () => new NotFoundException({ code: 'recurring_not_found' });

function toApi(t: TemplateWithLines) {
  return {
    id: t.id,
    clientId: t.clientId,
    name: t.name,
    currency: t.currency,
    frequency: t.frequency.toLowerCase(),
    startDate: isoDay(t.anchorDate),
    endDate: t.endDate ? isoDay(t.endDate) : null,
    nextRunOn: t.nextRunOn ? isoDay(t.nextRunOn) : null,
    runCount: t.runCount,
    dueInDays: t.dueInDays,
    autoSend: t.autoSend,
    active: t.active,
    lineItems: [...t.lineItems]
      .sort((a, b) => a.position - b.position)
      .map((l) => ({
        position: l.position,
        description: l.description,
        quantity: l.quantity.toFixed(),
        unitPriceCents: Number(l.unitPriceCents),
        taxRateBps: l.taxRateBps,
      })),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

@Injectable()
export class RecurringService {
  constructor(private readonly tenantDb: TenantDb) {}

  // `today` is injectable so schedule rules can be tested; the HTTP layer
  // always uses the real date.
  create(
    userId: string,
    orgId: string,
    dto: CreateRecurringDto,
    today = todayUtc(),
  ) {
    // Back-dated templates are refused: with auto-send on they could mass-mail
    // old invoices to a client.
    if (dto.startDate < today) {
      throw new BadRequestException({ code: 'start_date_in_past' });
    }
    const { lines } = computeInvoiceLines(dto.lineItems);
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      await this.assertClient(tx, dto.clientId);
      const template = await tx.recurringTemplate.create({
        data: {
          orgId,
          clientId: dto.clientId,
          name: dto.name,
          currency: dto.currency ?? 'USD',
          frequency: dto.frequency.toUpperCase() as RecurringFrequency,
          anchorDate: toDate(dto.startDate),
          nextRunOn: toDate(dto.startDate),
          endDate: dto.endDate ? toDate(dto.endDate) : null,
          dueInDays: dto.dueInDays ?? 30,
          autoSend: dto.autoSend ?? false,
        },
        select: { id: true },
      });
      await tx.recurringTemplateLineItem.createMany({
        data: this.lineRows(orgId, template.id, lines),
      });
      return toApi(await this.load(tx, template.id));
    });
  }

  list(userId: string, orgId: string, query: ListRecurringQuery) {
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      const rows = await tx.recurringTemplate.findMany({
        where: {
          deletedAt: null,
          ...(query.active ? { active: query.active === 'true' } : {}),
        },
        include: { lineItems: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return rows.map(toApi);
    });
  }

  get(userId: string, orgId: string, id: string) {
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      const row = await tx.recurringTemplate.findFirst({
        where: { id, deletedAt: null },
        include: { lineItems: true },
      });
      if (!row) throw notFound();
      return toApi(row);
    });
  }

  update(
    userId: string,
    orgId: string,
    id: string,
    dto: UpdateRecurringDto,
    today = todayUtc(),
  ) {
    const computed = dto.lineItems
      ? computeInvoiceLines(dto.lineItems)
      : undefined;
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      // Same row lock the generation job takes: an edit and a generation can
      // never interleave.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM recurring_templates
        WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
      if (locked.length === 0) throw notFound();
      const current = await this.load(tx, id);

      const anchor = isoDay(current.anchorDate);
      const frequency = current.frequency.toLowerCase() as Frequency;
      const endChanged = dto.endDate !== undefined;
      const endDate = endChanged
        ? (dto.endDate ?? null)
        : current.endDate
          ? isoDay(current.endDate)
          : null;
      if (endDate !== null && endDate < anchor) {
        throw new BadRequestException({ code: 'end_before_start' });
      }

      const active = dto.active ?? current.active;
      const resuming = !current.active && active;
      let runCount = current.runCount;
      let nextRunOn = current.nextRunOn ? isoDay(current.nextRunOn) : null;
      if (resuming || (endChanged && nextRunOn === null)) {
        // Resuming, or reviving an ended template: runs missed in the
        // meantime are skipped, never generated in a burst.
        ({ runCount, nextRunOn } = firstRunOnOrAfter(
          anchor,
          frequency,
          today,
          endDate,
        ));
      } else if (endChanged) {
        nextRunOn = runDateOrNull(anchor, frequency, runCount, endDate);
      }

      await tx.recurringTemplate.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.dueInDays !== undefined ? { dueInDays: dto.dueInDays } : {}),
          ...(dto.autoSend !== undefined ? { autoSend: dto.autoSend } : {}),
          ...(dto.active !== undefined ? { active } : {}),
          endDate: endDate ? toDate(endDate) : null,
          runCount,
          nextRunOn: nextRunOn ? toDate(nextRunOn) : null,
        },
      });
      if (computed) {
        await tx.recurringTemplateLineItem.deleteMany({
          where: { templateId: id },
        });
        await tx.recurringTemplateLineItem.createMany({
          data: this.lineRows(orgId, id, computed.lines),
        });
      }
      return toApi(await this.load(tx, id));
    });
  }

  // Soft delete: the template stops generating, but invoices it already made
  // keep pointing at it.
  async remove(userId: string, orgId: string, id: string): Promise<void> {
    await this.tenantDb.run({ userId, orgId }, async (tx) => {
      const res = await tx.recurringTemplate.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date(), active: false },
      });
      if (res.count === 0) throw notFound();
    });
  }

  private lineRows(
    orgId: string,
    templateId: string,
    lines: ReturnType<typeof computeInvoiceLines>['lines'],
  ) {
    return lines.map((l) => ({
      orgId,
      templateId,
      position: l.position,
      description: l.description,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      taxRateBps: l.taxRateBps,
    }));
  }

  private load(tx: TenantTx, id: string) {
    return tx.recurringTemplate.findFirstOrThrow({
      where: { id },
      include: { lineItems: true },
    });
  }

  private async assertClient(tx: TenantTx, clientId: string) {
    const client = await tx.client.findFirst({
      where: { id: clientId, deletedAt: null },
      select: { id: true },
    });
    if (!client) throw new BadRequestException({ code: 'unknown_client' });
  }
}
