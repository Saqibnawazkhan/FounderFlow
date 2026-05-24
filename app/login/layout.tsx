import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your FounderFlow workspace.",
};

// Bounce already-signed-in users straight to the dashboard so the login form
// never flashes for them (audit flaw #25). Server-side so it happens before
// any client JS runs.
export default async function LoginLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (session?.user?.id) redirect("/dashboard");
  return <>{children}</>;
}
