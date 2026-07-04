import { z } from "zod";

export const RequestEmailChangeSchema = z.object({
  newEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address")
    .max(200, "Email is too long"),
});
export type RequestEmailChangeInput = z.infer<typeof RequestEmailChangeSchema>;

export const ConfirmEmailChangeSchema = z.object({
  token: z.string().min(10),
});
export type ConfirmEmailChangeInput = z.infer<typeof ConfirmEmailChangeSchema>;
