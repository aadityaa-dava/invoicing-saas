import { z } from 'zod';

const role = z.enum(['owner', 'admin', 'member', 'viewer']);

export const addMemberSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    role,
  })
  .strict();

export const changeRoleSchema = z.object({ role }).strict();

export const userIdParamSchema = z.string().uuid();

export type AddMemberDto = z.infer<typeof addMemberSchema>;
export type ChangeRoleDto = z.infer<typeof changeRoleSchema>;
