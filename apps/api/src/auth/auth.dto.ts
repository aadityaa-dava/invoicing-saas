import { z } from 'zod';

// Length matters more than composition rules. The upper bound stops
// oversized inputs from burning CPU in the hash function.
export const signupSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(10).max(128),
  })
  .strict();
