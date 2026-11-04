import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permissions';

export const PERMISSION_KEY = 'rbac:permission';
export const ANY_MEMBER_KEY = 'rbac:any-member';

// Controllers name the permission they need, never a role.
export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);

// Explicit opt-in for org routes that any member may call.
export const AnyMember = () => SetMetadata(ANY_MEMBER_KEY, true);
