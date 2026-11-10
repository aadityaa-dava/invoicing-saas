import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type TenantTx = Prisma.TransactionClient;

export interface TenantContext {
  // Absent for system work (background jobs), which run under an org only.
  userId?: string;
  orgId?: string;
}

/**
 * Runs a unit of work inside one transaction with the RLS context set.
 *
 * Why set_config(..., is_local = true): the value lives only until the
 * transaction ends, so a pooled connection can never carry one tenant's
 * context into the next request. Session-level SET would leak.
 *
 * Why a tagged template: userId/orgId are bound as parameters, never
 * string-concatenated into SQL.
 */
@Injectable()
export class TenantDb {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (!ctx.userId && !ctx.orgId) {
      throw new Error('TenantContext needs a userId or an orgId');
    }
    return this.prisma.$transaction(async (tx) => {
      if (ctx.userId) {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
      }
      if (ctx.orgId) {
        await tx.$executeRaw`SELECT set_config('app.org_id', ${ctx.orgId}, true)`;
      }
      return fn(tx);
    });
  }
}
