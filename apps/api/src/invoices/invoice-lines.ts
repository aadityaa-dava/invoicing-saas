import { BadRequestException } from '@nestjs/common';
import type { CreateInvoiceDto } from './invoices.dto';
import { computeLine, computeTotals, MoneyError } from './money';

export type LineInput = CreateInvoiceDto['lineItems'][number];

// The single place line items are validated and priced. Used by invoices and
// by recurring templates, so a template that saves is guaranteed to produce a
// valid invoice later.
export function computeInvoiceLines(items: readonly LineInput[]) {
  try {
    const lines = items.map((item, index) => {
      const unitPriceCents = BigInt(item.unitPriceCents);
      const taxRateBps = item.taxRateBps ?? 0;
      const amounts = computeLine({
        quantity: item.quantity,
        unitPriceCents,
        taxRateBps,
      });
      return {
        position: index + 1,
        description: item.description,
        quantity: item.quantity,
        unitPriceCents,
        taxRateBps,
        ...amounts,
      };
    });
    return { lines, totals: computeTotals(lines) };
  } catch (e) {
    if (e instanceof MoneyError) {
      throw new BadRequestException({ code: e.code });
    }
    throw e;
  }
}
