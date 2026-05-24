import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Create a workspace",
  description:
    "Sign up for FounderFlow and start tracking finances, tasks, and momentum with your co-founders.",
};

// See /login layout — same redirect-when-signed-in guard for signup.
export default async function SignupLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (session?.user?.id) redirect("/dashboard");
  return <>{children}</>;
}
