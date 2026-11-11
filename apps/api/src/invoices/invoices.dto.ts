import { z } from 'zod';
import { MAX_LINE_AMOUNT_CENTS, MAX_LINES, parseQuantity } from './money';

// Two-decimal currencies only: the money rules assume 2 decimal places.
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'] as const;

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) => {
      const d = new Date(`${v}T00:00:00.000Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
    },
    { message: 'must be a real calendar date (YYYY-MM-DD)' },
  );

// A decimal STRING, never a JSON number: JSON numbers are floats.
const quantity = z.string().refine(
  (v) => {
    try {
      parseQuantity(v);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be a positive decimal string with at most 4 decimal places' },
);

const lineItem = z
  .object({
    description: z.string().trim().min(1).max(500),
    quantity,
    unitPriceCents: z
      .number()
      .int()
      .min(0)
      .max(Number(MAX_LINE_AMOUNT_CENTS)),
    taxRateBps: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export const lineItems = z.array(lineItem).min(1).max(MAX_LINES);

export const createInvoiceSchema = z
  .object({
    clientId: z.string().uuid(),
    currency: z.enum(CURRENCIES).optional(),
    issueDate: isoDate,
    dueDate: isoDate,
    lineItems,
  })
  .strict()
  .refine((v) => v.dueDate >= v.issueDate, {
    message: 'dueDate must not be before issueDate',
    path: ['dueDate'],
  });

// lineItems, when present, REPLACES all existing lines.
export const updateInvoiceSchema = z
  .object({
    clientId: z.string().uuid().optional(),
    currency: z.enum(CURRENCIES).optional(),
    issueDate: isoDate.optional(),
    dueDate: isoDate.optional(),
    lineItems: lineItems.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  });

export const listInvoicesQuerySchema = z
  .object({
    status: z.enum(['draft', 'sent', 'paid', 'overdue', 'void']).optional(),
  })
  .strict();

export const invoiceIdParamSchema = z.string().uuid();

export type CreateInvoiceDto = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceDto = z.infer<typeof updateInvoiceSchema>;
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;
