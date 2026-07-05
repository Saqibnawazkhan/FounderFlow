import { z } from "zod";
import { PasswordSchema } from "@/lib/schemas/password";

export const RequestPasswordResetSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});
export type RequestPasswordResetInput = z.infer<typeof RequestPasswordResetSchema>;

export const ResetPasswordSchema = z.object({
  token: z.string().min(10),
  password: PasswordSchema,
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
