"use client";

import { useEffect } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import { Toaster } from "react-hot-toast";
import { useStore } from "@/lib/store";
import { ConfirmDialogHost } from "@/components/ui/confirm-dialog";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Inner>{children}</Inner>
    </SessionProvider>
  );
}

function Inner({ children }: { children: React.ReactNode }) {
  const init = useStore((s) => s.init);
  const theme = useStore((s) => s.theme);
  const hydrateUser = useStore((s) => s.hydrateUser);
  const currentUser = useStore((s) => s.currentUser);
  const users = useStore((s) => s.users);
  const { data: session, status } = useSession();

  useEffect(() => {
    // Seed local demo data so the existing pages still render — we'll
    // migrate each page off this in follow-up commits.
    init();
  }, [init]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", theme === "dark");
    }
  }, [theme]);

  // Hydrate the Zustand `currentUser` from the Auth.js session so the existing
  // store-backed UI keeps working. When a real session is present, prefer it
  // over the locally-stored demo user.
  useEffect(() => {
    if (status === "loading") return;
    if (session?.user) {
      // Try to find a matching local user record (the demo seed adds them);
      // otherwise build a thin shim from the session payload.
      const sUser = session.user;
      const local = users.find((u) => u.email.toLowerCase() === sUser.email?.toLowerCase());
      hydrateUser(
        local ?? {
          id: sUser.id,
          name: sUser.name ?? "",
          email: sUser.email ?? "",
          password: "", // never used; bcrypt hash lives server-side only
          role: sUser.role,
          companyId: sUser.companyId,
          createdAt: new Date().toISOString(),
        }
      );
    } else if (status === "unauthenticated" && currentUser) {
      // Only drop the local user if there's NO real session; this lets the
      // demo workspace keep working when the user has not signed up.
      // (We don't auto-logout demo here — only on explicit signOut.)
    }
  }, [session, status, hydrateUser, users, currentUser]);

  return (
    <>
      {children}
      <ConfirmDialogHost />
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 3500,
          className: "!font-sans",
          style: {
            background: "rgb(var(--surface))",
            color: "rgb(var(--fg))",
            border: "1px solid rgb(var(--border))",
            borderRadius: "12px",
            padding: "12px 16px",
            fontSize: "14px",
            fontWeight: 500,
            boxShadow: "0 10px 30px rgb(0 0 0 / 0.18)",
          },
          success: {
            iconTheme: { primary: "rgb(var(--primary))", secondary: "rgb(var(--primary-fg))" },
          },
          error: {
            iconTheme: { primary: "rgb(var(--danger))", secondary: "#fff" },
          },
        }}
      />
    </>
  );
}
