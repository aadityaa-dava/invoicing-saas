import { z } from 'zod';

export const createClientSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    billingAddress: z.string().trim().min(1).max(500).optional(),
    taxId: z.string().trim().min(1).max(50).optional(),
  })
  .strict();

export type CreateClientDto = z.infer<typeof createClientSchema>;

export const updateClientSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
    billingAddress: z.string().trim().min(1).max(500).nullable().optional(),
    taxId: z.string().trim().min(1).max(50).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
  });

export const clientIdParamSchema = z.string().uuid();

export type UpdateClientDto = z.infer<typeof updateClientSchema>;
