import { z } from "zod";

// Re-auth guard: every irreversible account action asks for the password
// again so a hijacked session (stolen cookie, hostile shoulder-surfer at
// an unlocked laptop) can't nuke someone's data.
export const DeleteAccountSchema = z.object({
  password: z.string().min(1, "Enter your password to confirm"),
});
export type DeleteAccountInput = z.infer<typeof DeleteAccountSchema>;

// Workspace delete adds a second guard: type the workspace name exactly.
// GitHub / Vercel / Supabase all use this same pattern — matching muscle
// memory means users don't misread "type your name" as "click OK".
export const DeleteWorkspaceSchema = z.object({
  password: z.string().min(1, "Enter your password to confirm"),
  workspaceName: z.string().min(1, "Type the workspace name to confirm"),
});
export type DeleteWorkspaceInput = z.infer<typeof DeleteWorkspaceSchema>;
