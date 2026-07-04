import type { Metadata } from "next";

// page.tsx is a client component, so route metadata lives here (audit N9 —
// this page previously fell back to the root default title). No signed-in
// redirect on purpose: a logged-in user following an old reset email should
// still see the form, not get bounced mid-flow.
export const metadata: Metadata = {
  title: "Reset password",
  description: "Request a password-reset link for your FounderFlow account.",
};

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
