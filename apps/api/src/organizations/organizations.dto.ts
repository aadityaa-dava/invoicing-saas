import { z } from 'zod';

export const createOrganizationSchema = z
  .object({ name: z.string().trim().min(1).max(100) })
  .strict();

export type CreateOrganizationDto = z.infer<typeof createOrganizationSchema>;
