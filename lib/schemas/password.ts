import { z } from "zod";

/**
 * The one password policy for every credential-SETTING path — signup,
 * invite-accept, and password-reset. Previously signup + invite accepted a
 * weak 6-char password while only reset enforced 8 + complexity; this unifies
 * them on the stronger baseline for a finance product.
 *
 * NOTE: this is only for setting a NEW password. The login schema stays
 * `min(1)` ("required") so existing users whose passwords predate this policy
 * can still sign in.
 */
export const PasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(120, "Password is too long")
  .refine((v) => /[a-z]/.test(v), "Password needs a lowercase letter")
  .refine((v) => /[A-Z]/.test(v), "Password needs an uppercase letter")
  .refine((v) => /\d/.test(v), "Password needs a digit");
