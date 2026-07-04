import type { Metadata } from "next";

// page.tsx is a client component, so route metadata lives here (audit N9 —
// this page previously fell back to the root default title).
export const metadata: Metadata = {
  title: "Set new password",
  description: "Choose a new password for your FounderFlow account.",
};

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
