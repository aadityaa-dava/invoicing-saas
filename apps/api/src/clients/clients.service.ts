import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantDb } from '../tenancy/tenant-db.service';
import type { CreateClientDto, UpdateClientDto } from './clients.dto';

const clientSelect = {
  id: true,
  name: true,
  email: true,
  billingAddress: true,
  taxId: true,
  createdAt: true,
} as const;

const clientNotFound = () =>
  new NotFoundException({ code: 'client_not_found' });

// No query here filters by orgId: RLS scopes every statement to the
// transaction's organization. Soft-deleted rows (deletedAt set) are hidden by
// the application, not by RLS, so every read and write adds deletedAt: null.
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

  async get(userId: string, orgId: string, id: string) {
    const client = await this.tenantDb.run({ userId, orgId }, (tx) =>
      tx.client.findFirst({
        where: { id, deletedAt: null },
        select: clientSelect,
      }),
    );
    if (!client) throw clientNotFound();
    return client;
  }

  update(userId: string, orgId: string, id: string, dto: UpdateClientDto) {
    return this.tenantDb.run({ userId, orgId }, async (tx) => {
      const res = await tx.client.updateMany({
        where: { id, deletedAt: null },
        data: dto,
      });
      if (res.count === 0) throw clientNotFound();
      return tx.client.findFirstOrThrow({
        where: { id },
        select: clientSelect,
      });
    });
  }

  // Soft delete: history (future invoices) must survive.
  async remove(userId: string, orgId: string, id: string): Promise<void> {
    await this.tenantDb.run({ userId, orgId }, async (tx) => {
      const res = await tx.client.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (res.count === 0) throw clientNotFound();
    });
  }
}
