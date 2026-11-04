import {
  createParamDecorator,
  ExecutionContext,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedRequest, OrgMembership } from '../auth/auth.types';

export const CurrentMembership = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): OrgMembership => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.membership) throw new NotFoundException({ code: 'not_found' });
    return request.membership;
  },
);
