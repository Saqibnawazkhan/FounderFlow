import { z } from "zod";

// Treat empty-string envs the same as unset — `.env.local.example` ships
// with `SENTRY_DSN=""` etc. so devs can see the slot without opting into
// the feature, and z.string().url() would otherwise reject "" as invalid.
const optionalUrl = z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional());

const envSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NEXT_PUBLIC_DEFAULT_CURRENCY: z.string().default("PKR"),

  DATABASE_URL: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
  AUTH_URL: optionalUrl,

  EMAIL_VERIFICATION_REQUIRED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  UPSTASH_REDIS_REST_URL: optionalUrl,
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  SENTRY_DSN: optionalUrl,
});

const parsed = envSchema.safeParse({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_DEFAULT_CURRENCY: process.env.NEXT_PUBLIC_DEFAULT_CURRENCY,
  DATABASE_URL: process.env.DATABASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  AUTH_URL: process.env.AUTH_URL,
  EMAIL_VERIFICATION_REQUIRED: process.env.EMAIL_VERIFICATION_REQUIRED,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  SENTRY_DSN: process.env.SENTRY_DSN,
});

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables — see console");
}

export const env = parsed.data;
