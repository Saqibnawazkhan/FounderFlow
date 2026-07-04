import { z } from "zod";

export const VerifyEmailSchema = z.object({
  token: z.string().min(10),
});
export type VerifyEmailInput = z.infer<typeof VerifyEmailSchema>;
