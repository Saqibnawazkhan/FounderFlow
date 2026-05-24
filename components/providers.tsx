"use client";

import { useEffect, useRef } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import { Toaster } from "react-hot-toast";
import { useStore } from "@/lib/store";
import { getDirForLocale } from "@/lib/i18n/strings";
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
  const locale = useStore((s) => s.locale);
  const hydrateUser = useStore((s) => s.hydrateUser);
  const { data: session, status } = useSession();

  useEffect(() => {
    init();
  }, [init]);

  // PWA: register the service worker in production only. Dev gets weird
  // when SW caches Next.js hot-reload chunks. The browser scopes the worker
  // to "/" automatically because sw.js is served from the origin root.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    // Defer until after the page is interactive so registration doesn't
    // contend with the initial paint.
    const register = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
        // Failed registration is non-fatal — the app still works, just no
        // offline support. Log so we can spot persistent breakage.
        console.warn("[pwa] service worker registration failed:", err);
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", theme === "dark");
    }
  }, [theme]);

  // Sync <html lang + dir> with the active locale so RTL flips text + flow
  // automatically (and screen readers + spell-check pick the right language).
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = locale;
    document.documentElement.dir = getDirForLocale(locale);
  }, [locale]);

  // Hydrate Zustand `currentUser` once per session id. The previous
  // implementation included `users` in the dep array and constructed a fresh
  // object with `createdAt: new Date()` each run, which made the effect
  // re-fire on every state change and triggered React error #185 (max update
  // depth) in production. We now track the hydrated user id in a ref and
  // bail out if we've already adopted that identity.
  const hydratedUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (status === "loading") return;
    try {
      const sUser = session?.user;
      const newId = sUser?.id ?? null;
      if (hydratedUserIdRef.current === newId) return;

      if (sUser) {
        // Read users via getState() so Zustand subscriptions don't pull this
        // effect into a render loop when the seed populates.
        const localUsers = useStore.getState().users;
        const local = localUsers.find(
          (u) => u.email.toLowerCase() === (sUser.email ?? "").toLowerCase()
        );
        hydrateUser(
          local ?? {
            id: sUser.id ?? "",
            name: sUser.name ?? "",
            email: sUser.email ?? "",
            password: "",
            role: sUser.role ?? "member",
            companyId: sUser.companyId ?? "",
            createdAt: new Date().toISOString(),
          }
        );
      } else {
        // Genuinely unauthenticated — wipe any stale local identity.
        hydrateUser(null);
      }
      hydratedUserIdRef.current = newId;
    } catch (e) {
      console.error("session hydration failed:", e);
    }
  }, [session, status, hydrateUser]);

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
