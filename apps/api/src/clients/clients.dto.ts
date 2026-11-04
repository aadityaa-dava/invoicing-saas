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
