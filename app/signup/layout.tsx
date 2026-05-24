import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { homeRouteForRole, type Role } from "@/lib/auth/role-gates";

export const metadata: Metadata = {
  title: "Create a workspace",
  description:
    "Sign up for FounderFlow and start tracking finances, tasks, and momentum with your co-founders.",
};

// See /login layout — same redirect-when-signed-in guard for signup, routed
// per role so a member already in a workspace lands somewhere they can use.
export default async function SignupLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (session?.user?.id) {
    const role = (session.user.role as Role | undefined) ?? "member";
    redirect(homeRouteForRole(role));
  }
  return <>{children}</>;
}
