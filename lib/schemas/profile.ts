/**
 * Zod schemas for /settings profile + password mutations. Used by both the
 * client form (react-hook-form resolver) and the server action (re-parse).
 */

import { z } from "zod";
import { PasswordSchema } from "@/lib/schemas/password";

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
    // Shared strong policy (min 8 + mixed case + digit), same as
    // signup/invite/reset — one password bar across every set-password path.
    newPassword: PasswordSchema,
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

/* ─────────────────────────────────────────────────────────────────────── */
/* Handle                                                                  */
/* ─────────────────────────────────────────────────────────────────────── */

/**
 * The @mention handle (User.handle, `@@unique([companyId, handle])`).
 *
 * This is NOT a second display name. `name` is how PEOPLE address you and may
 * be written in any script; `handle` is how the mention PARSER addresses you,
 * and it has to survive MENTION_REGEX in lib/comments/mentions.ts —
 * `/@([a-zA-Z][a-zA-Z0-9-]*)/`. Anything this schema lets through that the
 * regex cannot tokenize is a handle that silently never notifies anyone, which
 * is the exact bug (FaultsAudit T16) the column was added to fix. Every rule
 * below is that regex, or the unique index, written as validation.
 *
 * DUPLICATION, DELIBERATE AND TEMPORARY: `lib/user/handle.ts`
 * (deriveHandle/uniqueHandle) does not exist in the tree yet. The grammar is
 * therefore stated here and, in SQL, in
 * prisma/migrations/20260925140000_add_user_handle/migration.sql. When that
 * module lands, this file should import its constants rather than restate
 * them — two copies of a grammar drift, and the drift is invisible until
 * someone's mentions stop resolving.
 */

/**
 * Three, not one. A one-character handle is a land-grab: `@a` is the cheapest
 * thing to claim in a workspace and the most valuable to squat, and a
 * two-character one is barely better. Three also keeps a handle
 * distinguishable from the accidental `@` in prose.
 */
export const MIN_HANDLE_LENGTH = 3;

/**
 * A handle is typed inside a sentence, so it is a token, not a title: 24 is
 * long enough for `muhammad-abdul-rehman` and short enough that a mention
 * doesn't swallow the line.
 *
 * LEGACY ROWS MAY SIT OUTSIDE THESE BOUNDS and that is fine — the backfill
 * derived handles from email local-parts with no length rule, so a workspace
 * can hold a two-character `jo` or a 30-character one. Nothing validates on
 * READ, so those handles keep working and keep resolving; the bounds only
 * gate a NEW value someone is choosing. The settings UI disables Save while
 * the field is unchanged, so a legacy holder is never asked to re-submit a
 * value this schema would now refuse.
 */
export const MAX_HANDLE_LENGTH = 24;

/**
 * Lowercase ASCII letters, digits and hyphens; must START WITH A LETTER and
 * end with a letter or digit.
 *
 *  - Leading letter, not merely "not a hyphen": MENTION_REGEX requires
 *    `[a-zA-Z]` first so that `@2024` doesn't tokenize as a mention in
 *    ordinary prose. A handle of `2024ali` would be as unaddressable as the
 *    empty string. The backfill forces the same leading letter (`u` || base)
 *    for this reason — keep the two in step.
 *  - No trailing hyphen: `@ali-` renders a dangling hyphen in every mention
 *    chip, and the token regex happily eats it, so the ugly version wins.
 *  - Lowercase only, NOT lowercased for you: the parser compares
 *    `token.toLowerCase()` against the stored handle, so an uppercase handle
 *    would match nothing. We reject rather than silently rewrite because the
 *    field's whole job is to show the exact token other people will type —
 *    quietly saving something other than what the preview showed defeats it.
 *    The settings input lowercases as you type, so nobody meets this rule the
 *    hard way.
 *
 * Consecutive hyphens are deliberately ALLOWED: the backfill's de-duplication
 * suffix is `--` (`ali--2`), so banning them would make a handle the product
 * itself assigned un-re-savable by its owner.
 */
export const HANDLE_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/;

/**
 * Trimmed first: people copy a handle out of a chat line and bring a space
 * with it. Everything else about a space is rejected — there is no such thing
 * as a handle with a space in the middle.
 */
export const HandleSchema = z
  .string()
  .trim()
  .min(MIN_HANDLE_LENGTH, `Handle must be at least ${MIN_HANDLE_LENGTH} characters`)
  .max(MAX_HANDLE_LENGTH, `Handle must be ${MAX_HANDLE_LENGTH} characters or fewer`)
  .regex(
    HANDLE_PATTERN,
    "Use lowercase letters, numbers and hyphens. Start with a letter, end with a letter or number."
  );

export const UpdateHandleSchema = z.object({ handle: HandleSchema });
export type UpdateHandleInput = z.infer<typeof UpdateHandleSchema>;
