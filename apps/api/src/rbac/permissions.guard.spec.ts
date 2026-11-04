import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { AnyMember, RequirePermission } from './require-permission.decorator';

class Routes {
  @RequirePermission('client:write')
  write() {}

  @AnyMember()
  anyone() {}

  undeclared() {}
}

function ctx(req: unknown, handler: () => void): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => Routes,
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  const guard = new PermissionsGuard(new Reflector());
  const orgReq = (role: string | null) => ({
    params: { orgId: 'x' },
    membership: role ? { orgId: 'x', role } : undefined,
  });

  it('ignores routes that are not org-scoped', () => {
    expect(guard.canActivate(ctx({ params: {} }, Routes.prototype.write))).toBe(
      true,
    );
  });

  it('allows a role that holds the permission', () => {
    expect(
      guard.canActivate(ctx(orgReq('MEMBER'), Routes.prototype.write)),
    ).toBe(true);
  });

  it('refuses a role that lacks the permission', () => {
    expect(() =>
      guard.canActivate(ctx(orgReq('VIEWER'), Routes.prototype.write)),
    ).toThrow(ForbiddenException);
  });

  it('allows any member on a route marked @AnyMember', () => {
    expect(
      guard.canActivate(ctx(orgReq('VIEWER'), Routes.prototype.anyone)),
    ).toBe(true);
  });

  it('FAILS CLOSED on an org route that declares nothing', () => {
    expect(() =>
      guard.canActivate(ctx(orgReq('OWNER'), Routes.prototype.undeclared)),
    ).toThrow(ForbiddenException);
  });

  it('FAILS CLOSED when no membership was resolved', () => {
    expect(() =>
      guard.canActivate(ctx(orgReq(null), Routes.prototype.anyone)),
    ).toThrow(ForbiddenException);
  });
});
