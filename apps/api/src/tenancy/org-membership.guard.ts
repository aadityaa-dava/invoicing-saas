import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { TenantDb } from './tenant-db.service';

const uuid = z.string().uuid();

/**
 * Applies to every route that has an :orgId parameter.
 *
 * Non-members get 404, not 403: a 403 would confirm that the organization
 * exists, letting an attacker enumerate valid ids. A malformed id gets the
 * same 404 (and never reaches Postgres, where a bad uuid cast would be a 500).
 *
 * The lookup runs with only the user context. The memberships policy lets a
 * user read their own rows, so the database itself limits what this can see.
 */
@Injectable()
export class OrgMembershipGuard implements CanActivate {
  constructor(private readonly tenantDb: TenantDb) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const rawOrgId: unknown = req.params?.orgId;
    if (rawOrgId === undefined) return true;

    if (!req.user) throw new UnauthorizedException({ code: 'unauthenticated' });

    const parsed = uuid.safeParse(rawOrgId);
    if (!parsed.success) throw new NotFoundException({ code: 'not_found' });
    const orgId = parsed.data;

    const userId = req.user.id;
    const membership = await this.tenantDb.run({ userId }, (tx) =>
      tx.membership.findFirst({
        where: { orgId, userId },
        select: { role: true },
      }),
    );
    if (!membership) throw new NotFoundException({ code: 'not_found' });

    req.membership = { orgId, role: membership.role };
    return true;
  }
}
