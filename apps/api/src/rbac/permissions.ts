import type { MembershipRole } from '../generated/prisma/client';

export const PERMISSIONS = [
  'client:read',
  'client:write',
  'client:delete',
  'invoice:read',
  'invoice:write',
  'invoice:send', // also covers creating payment links
  'invoice:void',
  'recurring:manage',
  'member:read',
  'member:manage',
  'audit:read',
  'billing:manage',
  'org:update',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// Owner holds everything. Every other role is an explicit allow-list, so a
// permission added in the future is owner-only until deliberately granted.
const ROLE_PERMISSIONS: Record<MembershipRole, ReadonlySet<Permission>> = {
  OWNER: new Set(PERMISSIONS),
  ADMIN: new Set<Permission>([
    'client:read',
    'client:write',
    'client:delete',
    'invoice:read',
    'invoice:write',
    'invoice:send',
    'invoice:void',
    'recurring:manage',
    'member:read',
    'member:manage',
    'audit:read',
    'org:update',
  ]),
  MEMBER: new Set<Permission>([
    'client:read',
    'client:write',
    'invoice:read',
    'invoice:write',
    'invoice:send',
    'recurring:manage',
    'member:read',
  ]),
  VIEWER: new Set<Permission>(['client:read', 'invoice:read', 'member:read']),
};

export function can(role: MembershipRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
