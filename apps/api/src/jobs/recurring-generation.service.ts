import { Injectable, Logger } from '@nestjs/common';
import { PlanService } from '../billing/plan.service';
import { addDays, isoDay, toDate } from '../common/dates';
import { PrismaService } from '../prisma/prisma.service';
import { computeInvoiceLines } from '../invoices/invoice-lines';
import { InvoicesService } from '../invoices/invoices.service';
import { runDateOrNull, type Frequency } from '../recurring/recurring-schedule';
import { TenantDb } from '../tenancy/tenant-db.service';

// Missed runs generated per template per tick. The rest continue next tick.
export const MAX_CATCH_UP = 12;

@Injectable()
export class RecurringGenerationService {
  private readonly logger = new Logger(RecurringGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDb,
    private readonly invoices: InvoicesService,
    private readonly plans: PlanService,
  ) {}

  // Cross-tenant discovery: organization ids only, through a narrow
  // SECURITY DEFINER function.
  async findOrgsWithDueTemplates(asOf: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ org_id: string }[]>`
      SELECT app_orgs_with_due_recurring(${asOf}::date) AS org_id`;
    return rows.map((row) => row.org_id);
  }

  // Runs under the org's own row-level-security context, with no user.
  async generateForOrg(
    orgId: string,
    asOf: string,
    maxRunsPerTemplate = MAX_CATCH_UP,
  ): Promise<{ templates: number; invoices: number }> {
    // Recurring invoices are a paid-plan feature. When the plan has lapsed the
    // due templates are paused rather than skipped: resuming needs the paid
    // plan and skips the runs that were missed, so upgrading later never
    // produces a burst of back-dated (and possibly auto-sent) invoices.
    const paid = await this.tenantDb.run({ orgId }, (tx) =>
      this.plans.isPaid(tx),
    );
    if (!paid) {
      const paused = await this.tenantDb.run({ orgId }, (tx) =>
        tx.recurringTemplate.updateMany({
          where: {
            active: true,
            deletedAt: null,
            nextRunOn: { lte: toDate(asOf) },
          },
          data: { active: false },
        }),
      );
      if (paused.count > 0) {
        this.logger.warn(
          `org ${orgId}: no paid plan, paused ${paused.count} due recurring template(s)`,
        );
      }
      return { templates: 0, invoices: 0 };
    }

    const due = await this.tenantDb.run({ orgId }, (tx) =>
      tx.recurringTemplate.findMany({
        where: {
          active: true,
          deletedAt: null,
          nextRunOn: { lte: toDate(asOf) },
        },
        select: { id: true },
        orderBy: { nextRunOn: 'asc' },
      }),
    );

    let templates = 0;
    let invoices = 0;
    for (const { id } of due) {
      const result = await this.generateOne(
        orgId,
        id,
        asOf,
        maxRunsPerTemplate,
      );
      if (result.invoiceIds.length > 0) templates += 1;
      invoices += result.invoiceIds.length;

      // After the generation has committed, through the normal send path, so
      // numbering, locking and the email behave exactly as for a manual send.
      // Best-effort: on failure the invoice simply stays a draft.
      if (result.autoSend) {
        for (const invoiceId of result.invoiceIds) {
          try {
            await this.invoices.send(undefined, orgId, invoiceId);
          } catch (err) {
            this.logger.error(
              `auto-send failed for invoice ${invoiceId}: ${(err as Error).message}`,
            );
          }
        }
      }
    }
    return { templates, invoices };
  }

  private generateOne(
    orgId: string,
    templateId: string,
    asOf: string,
    maxRuns: number,
  ): Promise<{ invoiceIds: string[]; autoSend: boolean }> {
    return this.tenantDb.run({ orgId }, async (tx) => {
      // SKIP LOCKED: a template being edited right now is left for the next
      // tick instead of making a background job wait. The conditions are
      // re-checked after the lock, so a concurrent run that already advanced
      // the template makes this one a no-op.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM recurring_templates
        WHERE id = ${templateId}::uuid
          AND active AND deleted_at IS NULL
          AND next_run_on <= ${asOf}::date
        FOR UPDATE SKIP LOCKED`;
      if (locked.length === 0) return { invoiceIds: [], autoSend: false };

      const t = await tx.recurringTemplate.findFirstOrThrow({
        where: { id: templateId },
        include: {
          lineItems: true,
          client: { select: { deletedAt: true } },
        },
      });
      if (t.client.deletedAt) {
        this.logger.warn(`template ${t.id}: client was deleted, skipped`);
        return { invoiceIds: [], autoSend: false };
      }

      const anchor = isoDay(t.anchorDate);
      const frequency = t.frequency.toLowerCase() as Frequency;
      const endDate = t.endDate ? isoDay(t.endDate) : null;
      const { lines, totals } = computeInvoiceLines(
        [...t.lineItems]
          .sort((a, b) => a.position - b.position)
          .map((l) => ({
            description: l.description,
            quantity: l.quantity.toFixed(),
            unitPriceCents: Number(l.unitPriceCents),
            taxRateBps: l.taxRateBps,
          })),
      );

      let runCount = t.runCount;
      let next = t.nextRunOn ? isoDay(t.nextRunOn) : null;
      let processed = 0;
      const invoiceIds: string[] = [];
      while (next !== null && next <= asOf && processed < maxRuns) {
        // If this run already has an invoice (partial state from an earlier
        // failure), do not create another: just move the schedule forward.
        const existing = await tx.invoice.findFirst({
          where: { recurringTemplateId: t.id, recurringRunOn: toDate(next) },
          select: { id: true },
        });
        if (!existing) {
          const invoice = await tx.invoice.create({
            data: {
              orgId,
              clientId: t.clientId,
              currency: t.currency,
              issueDate: toDate(next),
              dueDate: toDate(addDays(next, t.dueInDays)),
              subtotalCents: totals.subtotalCents,
              taxCents: totals.taxCents,
              totalCents: totals.totalCents,
              recurringTemplateId: t.id,
              recurringRunOn: toDate(next),
            },
            select: { id: true },
          });
          await tx.invoiceLineItem.createMany({
            data: lines.map((l) => ({ orgId, invoiceId: invoice.id, ...l })),
          });
          invoiceIds.push(invoice.id);
        }
        runCount += 1;
        next = runDateOrNull(anchor, frequency, runCount, endDate);
        processed += 1;
      }

      await tx.recurringTemplate.update({
        where: { id: t.id },
        data: { runCount, nextRunOn: next ? toDate(next) : null },
      });
      return { invoiceIds, autoSend: t.autoSend };
    });
  }
}
