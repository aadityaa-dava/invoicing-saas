import { Injectable } from '@nestjs/common';
import { TenantDb } from '../tenancy/tenant-db.service';

@Injectable()
export class MembersService {
  constructor(private readonly tenantDb: TenantDb) {}

  async list(userId: string, orgId: string) {
    const rows = await this.tenantDb.run({ userId, orgId }, (tx) =>
      tx.membership.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          role: true,
          createdAt: true,
          user: { select: { id: true, email: true } },
        },
      }),
    );
    return rows.map((r) => ({
      userId: r.user.id,
      email: r.user.email,
      role: r.role.toLowerCase(),
      joinedAt: r.createdAt,
    }));
  }
}
