import { z } from "zod";

export const RequestPasswordResetSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});
export type RequestPasswordResetInput = z.infer<typeof RequestPasswordResetSchema>;

// Password rules mirror the signup form: 8+ chars with mixed case + a digit.
// Enforced server-side so a client that skips the RHF pattern still gets
// rejected before the hash lands.
const PasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine((v) => /[a-z]/.test(v), "Password needs a lowercase letter")
  .refine((v) => /[A-Z]/.test(v), "Password needs an uppercase letter")
  .refine((v) => /\d/.test(v), "Password needs a digit");

export const ResetPasswordSchema = z.object({
  token: z.string().min(10),
  password: PasswordSchema,
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
