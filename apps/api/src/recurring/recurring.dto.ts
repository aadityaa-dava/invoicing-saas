import { z } from 'zod';
import { CURRENCIES, isoDate, lineItems } from '../invoices/invoices.dto';

const frequency = z.enum(['weekly', 'monthly', 'quarterly', 'yearly']);
const name = z.string().trim().min(1).max(200);
const dueInDays = z.number().int().min(0).max(365);

export const createRecurringSchema = z
  .object({
    clientId: z.string().uuid(),
    name,
    currency: z.enum(CURRENCIES).optional(),
    frequency,
    startDate: isoDate,
    endDate: isoDate.optional(),
    dueInDays: dueInDays.optional(),
    autoSend: z.boolean().optional(),
    lineItems,
  })
  .strict()
  .refine((v) => v.endDate === undefined || v.endDate >= v.startDate, {
    message: 'endDate must not be before startDate',
    path: ['endDate'],
  });

// Frequency, start date and client are fixed after creation: changing them
// would change the meaning of every past and future run. Create a new
// template instead.
export const updateRecurringSchema = z
  .object({
    name: name.optional(),
    dueInDays: dueInDays.optional(),
    autoSend: z.boolean().optional(),
    endDate: isoDate.nullable().optional(),
    active: z.boolean().optional(),
    lineItems: lineItems.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  });

export const listRecurringQuerySchema = z
  .object({ active: z.enum(['true', 'false']).optional() })
  .strict();

export const recurringIdParamSchema = z.string().uuid();

export type CreateRecurringDto = z.infer<typeof createRecurringSchema>;
export type UpdateRecurringDto = z.infer<typeof updateRecurringSchema>;
export type ListRecurringQuery = z.infer<typeof listRecurringQuerySchema>;
