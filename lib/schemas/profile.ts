/**
 * Zod schemas for /settings profile + password mutations. Used by both the
 * client form (react-hook-form resolver) and the server action (re-parse).
 */

import { z } from "zod";

// Name only. Email changes go through the verify-the-new-address flow in
// lib/actions/email-change.ts (audit S3) — a login email can't be swapped
// without proving control of the destination inbox.
export const UpdateProfileSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80, "Name is too long"),
});
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: z
      .string()
      .min(6, "New password must be at least 6 characters")
      .max(200, "New password is too long"),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: "New password must differ from current",
    path: ["newPassword"],
  });
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
