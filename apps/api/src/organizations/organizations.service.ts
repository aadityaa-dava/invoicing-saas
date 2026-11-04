import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { TenantDb } from '../tenancy/tenant-db.service';

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  // Random suffix keeps slugs unique without a check-then-insert race.
  return `${base || 'org'}-${randomBytes(3).toString('hex')}`;
}

@Injectable()
export class OrganizationsService {
  constructor(private readonly tenantDb: TenantDb) {}

  // The id is generated here, before any INSERT, because the RLS policy on
  // organizations requires id = app.org_id. The context and the row agree
  // by construction, and a client can never choose the id.
  create(userId: string, name: string) {
    const orgId = randomUUID();
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      const org = await tx.organization.create({
        data: { id: orgId, name, slug: slugify(name) },
        select: { id: true, name: true, slug: true, createdAt: true },
      });
      await tx.membership.create({
        data: { orgId, userId, role: 'OWNER' },
      });
      return { ...org, role: 'owner' as const };
    });
  }

  // No org context here: the RLS policies themselves limit the result to
  // organizations this user belongs to.
  async listMine(userId: string) {
    const rows = await this.tenantDb.run({ userId }, (tx) =>
      tx.membership.findMany({
        where: { userId },
        select: {
          role: true,
          org: { select: { id: true, name: true, slug: true } },
        },
        orderBy: { org: { name: 'asc' } },
      }),
    );
    return rows.map((r) => ({ ...r.org, role: r.role.toLowerCase() }));
  }
}
