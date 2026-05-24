/**
 * Zod schemas for the auth surface. Shared between the server actions in
 * lib/actions/auth.ts and the RHF resolvers on /login and /signup so
 * validation behaves identically on both sides of the wire.
 */

import { z } from "zod";

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof LoginSchema>;

export const SignupSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters").max(120),
  companyName: z.string().trim().min(1, "Company name is required").max(80),
  industry: z.string().trim().min(1, "Pick an industry").max(80),
});

export type SignupInput = z.infer<typeof SignupSchema>;

// Step 1 of the signup wizard validates a subset client-side so we can advance
// without touching the company fields. Server still runs full SignupSchema.
export const SignupStep1Schema = SignupSchema.pick({
  name: true,
  email: true,
  password: true,
});
