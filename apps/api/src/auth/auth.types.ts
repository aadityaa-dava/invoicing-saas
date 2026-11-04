import type { Request } from 'express';
import type { MembershipRole } from '../generated/prisma/client';

export interface AuthUser {
  id: string;
}

// Set by OrgMembershipGuard on any route that has an :orgId parameter.
export interface OrgMembership {
  orgId: string;
  role: MembershipRole;
}

export type AuthenticatedRequest = Request & {
  user?: AuthUser;
  membership?: OrgMembership;
};
