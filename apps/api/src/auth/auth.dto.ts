import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(254);

// Length matters more than composition rules. The upper bound stops
// oversized inputs from burning CPU in the hash function.
const newPassword = z.string().min(10).max(128);

export const signupSchema = z.object({ email, password: newPassword }).strict();

// Login does not repeat the password policy, so it reveals nothing about it.
export const loginSchema = z
  .object({ email, password: z.string().min(1).max(128) })
  .strict();

export const verifyEmailSchema = z
  .object({ token: z.string().min(1).max(200) })
  .strict();

export const forgotPasswordSchema = z.object({ email }).strict();

export const resetPasswordSchema = z
  .object({ token: z.string().min(1).max(200), password: newPassword })
  .strict();

export const resendVerificationSchema = z.object({ email }).strict();
