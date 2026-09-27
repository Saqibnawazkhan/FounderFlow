import { z } from "zod";

export const VerifyEmailSchema = z.object({
  token: z.string().min(10),
});
