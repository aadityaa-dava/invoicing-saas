import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { can, type Permission } from './permissions';
import { ANY_MEMBER_KEY, PERMISSION_KEY } from './require-permission.decorator';

/**
 * Runs after OrgMembershipGuard. Fails closed: an org-scoped route must
 * declare @RequirePermission(...) or @AnyMember(), or every call is refused.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (req.params?.orgId === undefined) return true; // not org-scoped

    const forbidden = () => new ForbiddenException({ code: 'forbidden' });
    const targets = [context.getHandler(), context.getClass()];

    // No membership means the membership guard did not run: refuse.
    if (!req.membership) throw forbidden();

    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      PERMISSION_KEY,
      targets,
    );
    if (required) {
      if (!can(req.membership.role, required)) throw forbidden();
      return true;
    }

    const anyMember = this.reflector.getAllAndOverride<boolean | undefined>(
      ANY_MEMBER_KEY,
      targets,
    );
    if (anyMember) return true;

    throw forbidden(); // undeclared org route
  }
}
