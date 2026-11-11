import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantDb } from '../tenancy/tenant-db.service';

export const todayUtc = () => new Date().toISOString().slice(0, 10);

@Injectable()
export class OverdueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDb,
  ) {}

  // Cross-tenant discovery: organization ids only, through a narrow
  // SECURITY DEFINER function. No invoice data crosses the tenant boundary.
  async findOrgsWithOverdueInvoices(asOf: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ org_id: string }[]>`
      SELECT app_orgs_with_overdue_invoices(${asOf}::date) AS org_id`;
    return rows.map((row) => row.org_id);
  }

  // Runs under the org's own row-level-security context, with no user.
  // Idempotent: only sent invoices past their due date match, so a repeat
  // run updates nothing. It takes the same row locks as send and void, so it
  // serializes with them instead of racing.
  markOverdue(orgId: string, asOf: string): Promise<number> {
    return this.tenantDb.run({ orgId }, async (tx) => {
      const { count } = await tx.invoice.updateMany({
        where: {
          status: 'SENT',
          deletedAt: null,
          dueDate: { lt: new Date(`${asOf}T00:00:00.000Z`) },
        },
        data: { status: 'OVERDUE' },
      });
      return count;
    });
  }
}
