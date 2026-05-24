/**
 * Shared session helper for lib/queries/. RSC pages live behind middleware
 * that bounces anonymous users to /login, so by the time these queries run
 * the session is guaranteed present — but we still re-validate it server-side
 * so a missing session never silently returns another company's data.
 *
 * Throws on missing session. The (app)/error.tsx boundary catches it and
 * shows the standard error UI with the digest.
 */

import { auth } from "@/lib/auth";

export type ScopedSession = {
  userId: string;
  userName: string;
  email: string;
  companyId: string;
  role: "admin" | "cofounder" | "member";
};

export async function requireScopedSession(): Promise<ScopedSession> {
  const session = await auth();
  if (!session?.user?.id || !session.user.companyId) {
    throw new Error("Not authenticated");
  }
  return {
    userId: session.user.id,
    userName: session.user.name ?? "",
    email: session.user.email ?? "",
    companyId: session.user.companyId,
    role: session.user.role,
  };
}
