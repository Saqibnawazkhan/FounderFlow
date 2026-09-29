"use client";

import { useEffect, useRef } from "react";
import { SessionProvider, useSession } from "next-auth/react";
import { MotionConfig } from "framer-motion";
import { Toaster } from "react-hot-toast";
import { useStore } from "@/lib/store";
import { documentLangForLocale, getDirForLocale } from "@/lib/i18n/strings";
import { ConfirmDialogHost } from "@/components/ui/confirm-dialog";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    /* reducedMotion="user" — WCAG 2.3.3, audit a11y-009.
     *
     * app/globals.css already has a `@media (prefers-reduced-motion: reduce)`
     * block pinning animation/transition duration to 0.01ms, and it is correct:
     * it neutralises every CSS-driven animation in the product (Radix
     * `data-state` cross-fades, the `animate-pulse` skeletons, the `.reveal`
     * landing stagger). It cannot reach framer-motion, which rewrites inline
     * `transform` and `opacity` from JS on every frame — a stylesheet cannot win
     * against a style being reassigned 60 times a second.
     *
     * framer-motion's own switch is MotionConfigContext.reducedMotion, and its
     * DEFAULT IS "never" — meaning *never reduce*, i.e. ignore the OS. So with no
     * MotionConfig in the tree, six of the eight <motion.div>s in the product
     * travelled for users who had explicitly asked their OS not to do that: the
     * topbar notification and account panels (y + scale), both theme-toggle icons
     * (rotate ±90°), the project-detail status popover (y + scale) and every
     * empty state (y). The other two — the mobile-drawer backdrop and the clock
     * widget — animate opacity alone and were always fine. (The drawer panel
     * itself slides via a CSS `transition-[transform,width]` class on the
     * <aside>, so globals.css already covered it.)
     *
     * "user" follows the media query. NOT "always": framer only snaps
     * `positionalKeys` (width/height/top/left/right/bottom + every transform)
     * under reduced motion and lets opacity keep animating, which is the right
     * reading of 2.3.3 — a cross-fade is not a vestibular trigger — and
     * "always" would strip motion from people who never asked.
     *
     * Outermost so it covers `children` (the whole route tree, since
     * app/layout.tsx renders <Providers>{children}</Providers>), the toasts and
     * the confirm-dialog host, and any future motion usage, without touching a
     * single component file. framer-motion declares `sideEffects: false`, so
     * importing just MotionConfig here adds the context provider and nothing
     * else to the shared bundle.
     *
     * Covered by tests/components/providers.test.tsx, which has to override the
     * global `window.matchMedia` stub in tests/setup.ts — that stub answers
     * `matches: false` for every query, so a reduced-motion test written against
     * it passes no matter what this line says. */
    <MotionConfig reducedMotion="user">
      <SessionProvider>
        <Inner>{children}</Inner>
      </SessionProvider>
    </MotionConfig>
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

  // Sync <html lang + dir> with the active locale. TWO SEPARATE DECISIONS, and
  // this line used to make one decision serve both (audit i18n-001).
  //
  //   dir  — presentation. Follows the locale outright: the user picked Urdu,
  //          the shell really is Urdu, and it has to mirror.
  //   lang — a factual claim about the text a screen reader is about to
  //          pronounce. It follows `documentLangForLocale`, which keeps the
  //          document tagged as its PREDOMINANT language while a locale's
  //          coverage is still partial. `lang = locale` told assistive tech to
  //          read the whole product — including every hardcoded English
  //          aria-label and toast — with Urdu phonemes.
  //
  // See lib/i18n/strings.ts for the full reasoning and for the one-line switch
  // that turns lang="ur" back on when Urdu coverage lands.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = documentLangForLocale(locale);
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
        // ariaProps make each toast a live region so screen readers announce
        // it as it arrives (audit S14: previously silent). Error toasts use
        // assertive; success/info toasts use polite so a burst of successes
        // doesn't interrupt whatever the user was reading.
        toastOptions={{
          duration: 3500,
          className: "!font-sans",
          ariaProps: { role: "status", "aria-live": "polite" },
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
            ariaProps: { role: "alert", "aria-live": "assertive" },
            iconTheme: { primary: "rgb(var(--danger))", secondary: "#fff" },
          },
        }}
      />
    </>
  );
}
