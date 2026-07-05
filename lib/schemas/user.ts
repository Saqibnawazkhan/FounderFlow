/**
 * Zod schemas for team/user mutations. Shared between server actions and
 * the team UI / invite-accept page.
 */

import { z } from "zod";
import { PasswordSchema } from "@/lib/schemas/password";

const Role = z.enum(["admin", "cofounder", "member"]);

/**
 * What the admin fills in on /team's invite modal.
 *
 * No password field — Phase 6 moved to email-link invites, so the admin
 * never sets a password on the invitee's behalf (closes audit flaw #7).
 * Admins can invite as Co-Founder or Team Member only; minting another
 * admin requires a separate updateUserRoleAction call.
 */
export const InviteUserSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  role: z.enum(["cofounder", "member"]),
});

export type InviteUserInput = z.infer<typeof InviteUserSchema>;

/**
 * What the invitee submits on /invite/[token] to claim their seat.
 *
 * Name + role + email are pulled from the InviteToken row by the action;
 * only the password comes from the form. The token itself is validated
 * separately so the schema stays focused on user-supplied input.
 */
export const AcceptInviteSchema = z.object({
  token: z.string().min(1, "Missing invite token"),
  password: PasswordSchema,
});

export type AcceptInviteInput = z.infer<typeof AcceptInviteSchema>;

export const UpdateRoleSchema = z.object({
  userId: z.string().min(1),
  role: Role,
});

export type UpdateRoleInput = z.infer<typeof UpdateRoleSchema>;
