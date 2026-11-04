import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MembershipRole } from '../generated/prisma/client';
import { TenantDb, type TenantTx } from '../tenancy/tenant-db.service';
import type { AddMemberDto } from './members.dto';

export interface Actor {
  userId: string;
  orgId: string;
  role: MembershipRole;
}

type RoleName = AddMemberDto['role'];
const toDb = (r: RoleName) => r.toUpperCase() as MembershipRole;

const ownerRequired = () =>
  new ForbiddenException({ code: 'owner_required' });
const lastOwner = () => new ConflictException({ code: 'last_owner' });
const memberNotFound = () =>
  new NotFoundException({ code: 'member_not_found' });

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

  // Adds an existing, verified user. Only an owner may grant the owner role.
  async add(actor: Actor, dto: AddMemberDto) {
    if (dto.role === 'owner' && actor.role !== 'OWNER') throw ownerRequired();
    try {
      return await this.tenantDb.run(
        { userId: actor.userId, orgId: actor.orgId },
        async (tx) => {
          const user = await tx.user.findFirst({
            where: { email: dto.email, emailVerifiedAt: { not: null } },
            select: { id: true, email: true },
          });
          if (!user) throw new NotFoundException({ code: 'user_not_found' });

          const existing = await tx.membership.findFirst({
            where: { orgId: actor.orgId, userId: user.id },
            select: { id: true },
          });
          if (existing) {
            throw new ConflictException({ code: 'already_member' });
          }

          const m = await tx.membership.create({
            data: {
              orgId: actor.orgId,
              userId: user.id,
              role: toDb(dto.role),
            },
            select: { role: true, createdAt: true },
          });
          return {
            userId: user.id,
            email: user.email,
            role: m.role.toLowerCase(),
            joinedAt: m.createdAt,
          };
        },
      );
    } catch (e) {
      // Two concurrent adds of the same user: the unique index decides.
      if ((e as { code?: string }).code === 'P2002') {
        throw new ConflictException({ code: 'already_member' });
      }
      throw e;
    }
  }

  async changeRole(actor: Actor, targetUserId: string, newRole: RoleName) {
    const next = toDb(newRole);
    if (next === 'OWNER' && actor.role !== 'OWNER') throw ownerRequired();

    return this.tenantDb.run(
      { userId: actor.userId, orgId: actor.orgId },
      async (tx) => {
        const ownerCount = await this.lockOwners(tx, actor.orgId);
        const target = await tx.membership.findFirst({
          where: { orgId: actor.orgId, userId: targetUserId },
          select: { role: true },
        });
        if (!target) throw memberNotFound();

        if (target.role === 'OWNER') {
          if (actor.role !== 'OWNER') throw ownerRequired();
          if (next !== 'OWNER' && ownerCount <= 1) throw lastOwner();
        }

        if (target.role !== next) {
          await tx.membership.updateMany({
            where: { orgId: actor.orgId, userId: targetUserId },
            data: { role: next },
          });
        }
        return { userId: targetUserId, role: newRole };
      },
    );
  }

  async remove(actor: Actor, targetUserId: string): Promise<void> {
    await this.tenantDb.run(
      { userId: actor.userId, orgId: actor.orgId },
      async (tx) => {
        const ownerCount = await this.lockOwners(tx, actor.orgId);
        const target = await tx.membership.findFirst({
          where: { orgId: actor.orgId, userId: targetUserId },
          select: { role: true },
        });
        if (!target) throw memberNotFound();

        if (target.role === 'OWNER') {
          if (actor.role !== 'OWNER') throw ownerRequired();
          if (ownerCount <= 1) throw lastOwner();
        }

        await tx.membership.deleteMany({
          where: { orgId: actor.orgId, userId: targetUserId },
        });
      },
    );
  }

  // Locks every owner row of the org until the transaction ends, so two
  // concurrent demotions/removals cannot both see "there is another owner".
  // Returns the owner count AS SEEN AFTER ACQUIRING THE LOCKS.
  private async lockOwners(tx: TenantTx, orgId: string): Promise<number> {
    const rows = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM memberships
      WHERE org_id = ${orgId}::uuid AND role = 'owner'
      FOR UPDATE`;
    return rows.length;
  }
}
