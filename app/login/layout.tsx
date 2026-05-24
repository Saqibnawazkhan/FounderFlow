import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { homeRouteForRole, type Role } from "@/lib/auth/role-gates";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your FounderFlow workspace.",
};

// Bounce already-signed-in users to their role-appropriate home so the login
// form never flashes (audit flaw #25). Server-side so it happens before any
// client JS runs. Members go to /tasks (their first allowed page); admins
// and cofounders go to /dashboard.
export default async function LoginLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (session?.user?.id) {
    const role = (session.user.role as Role | undefined) ?? "member";
    redirect(homeRouteForRole(role));
  }
  return <>{children}</>;
}
