import { Injectable } from '@nestjs/common';
import { TenantDb } from '../tenancy/tenant-db.service';
import type { CreateClientDto } from './clients.dto';

const clientSelect = {
  id: true,
  name: true,
  email: true,
  billingAddress: true,
  taxId: true,
  createdAt: true,
} as const;

@Injectable()
export class ClientsService {
  constructor(private readonly tenantDb: TenantDb) {}

  // orgId is a required column, so the INSERT names it, but the RLS
  // WITH CHECK rejects the row unless it equals the transaction's org.
  create(userId: string, orgId: string, dto: CreateClientDto) {
    return this.tenantDb.run({ userId, orgId }, (tx) =>
      tx.client.create({ data: { orgId, ...dto }, select: clientSelect }),
    );
  }

  // Deliberately no `where: { orgId }`: RLS scopes the result to the
  // current organization. Soft-deleted rows are hidden by the app, not RLS.
  // Capped for now; real pagination arrives in Phase 9.
  list(userId: string, orgId: string) {
    return this.tenantDb.run({ userId, orgId }, (tx) =>
      tx.client.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: clientSelect,
      }),
    );
  }
}
