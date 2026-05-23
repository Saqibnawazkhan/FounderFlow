/**
 * Zod schemas for team/user mutations. Shared between server actions and the
 * Invite form on /team.
 */

import { z } from "zod";

const Role = z.enum(["admin", "cofounder", "member"]);

export const InviteUserSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(6, "Temporary password must be at least 6 characters").max(120),
  // Admins can invite as Co-Founder or Team Member only — minting another
  // Admin needs a separate intentional action (role change after invite).
  role: z.enum(["cofounder", "member"]),
});

export type InviteUserInput = z.infer<typeof InviteUserSchema>;

export const UpdateRoleSchema = z.object({
  userId: z.string().min(1),
  role: Role,
});

export type UpdateRoleInput = z.infer<typeof UpdateRoleSchema>;
