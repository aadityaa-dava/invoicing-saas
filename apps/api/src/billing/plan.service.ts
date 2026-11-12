import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { TenantTx } from '../tenancy/tenant-db.service';
import { hasPaidPlan } from './plans';

// Plan checks run inside the caller's tenant transaction, so row-level
// security scopes them to the organization the request is acting for.
@Injectable()
export class PlanService {
  async isPaid(tx: TenantTx): Promise<boolean> {
    const subscription = await tx.subscription.findFirst({
      select: { plan: true, status: true },
    });
    return hasPaidPlan(subscription);
  }

  async assertPaid(tx: TenantTx): Promise<void> {
    if (!(await this.isPaid(tx))) {
      throw new HttpException(
        { code: 'plan_required' },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
  }
}
