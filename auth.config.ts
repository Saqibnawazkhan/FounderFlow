/**
 * Edge-safe Auth.js base config.
 *
 * Middleware runs in the Edge runtime, which can't load Prisma (Node-only).
 * This file holds the bits middleware needs — callbacks, pages, session
 * strategy — with NO providers. lib/auth.ts spreads this and adds the
 * Credentials provider (which calls bcrypt + Prisma) for the Node runtime.
 *
 * Pattern documented at https://authjs.dev/guides/edge-compatibility
 */

import type { NextAuthConfig } from "next-auth";
import { NextResponse } from "next/server";
import {
  canSeeFinances,
  homeRouteForRole,
  isMemberBlockedRoute,
  type Role,
} from "@/lib/auth/role-gates";

/**
 * The three roles, as an allow-list. Anything else — a claim from a token
 * minted by a future deploy, a role that was renamed, a hand-edited cookie —
 * resolves to the LEAST privileged role rather than sliding past a
 * `role === "member"` comparison. See `authorized()` for why that matters.
 */
const KNOWN_ROLES: readonly Role[] = ["admin", "cofounder", "member"];

function roleFromToken(claim: unknown): Role {
  return typeof claim === "string" && KNOWN_ROLES.indexOf(claim as Role) !== -1
    ? (claim as Role)
    : "member";
}

export const authConfig = {
  trustHost: true,
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [], // Credentials provider lives in lib/auth.ts (Node-only).
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.companyId = (user as { companyId?: string }).companyId;
        token.role = (user as { role?: "admin" | "cofounder" | "member" }).role;
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = (token.id as string) ?? "";
        session.user.companyId = (token.companyId as string) ?? "";
        session.user.role = (token.role as "admin" | "cofounder" | "member") ?? "member";
      }
      return session;
    },
    authorized({ auth, request }) {
      // Used by middleware. Public surface: landing, auth flows, static.
      const { pathname } = request.nextUrl;
      const isPublic =
        pathname === "/" ||
        pathname === "/offline" || // PWA offline fallback — must work without a session
        pathname.startsWith("/login") ||
        pathname.startsWith("/signup") ||
        pathname.startsWith("/forgot-password") ||
        pathname.startsWith("/reset-password") ||
        pathname.startsWith("/verify-email") || // also covers /verify-email-change
        pathname.startsWith("/invite/") || // /invite/[token] for email-link onboarding
        pathname.startsWith("/api/auth") ||
        pathname.startsWith("/api/cron/") || // protected by CRON_SECRET header instead
        pathname.startsWith("/api/webhooks/") || // protected by provider HMAC signature instead
        pathname === "/robots.txt" ||
        pathname === "/sitemap.xml" ||
        pathname === "/icon.svg" ||
        pathname === "/icon-maskable.svg" ||
        pathname === "/manifest.json" ||
        pathname === "/sw.js";
      if (isPublic) return true;

      // ── FAIL CLOSED, and do not settle for an existence check ─────────────
      //
      // `if (!auth) return false` was this line, and it is precisely the shape
      // of the CRITICAL next-auth advisory "Configuration errors can cause
      // existence-based auth checks to fail open": a session OBJECT existing is
      // not the same as it identifying somebody. A token that decodes to
      // `{ user: {} }` — a misconfigured secret, a half-written claim set, a
      // legacy cookie from before `companyId` was minted — passed that test and
      // was allowed onto every non-finance route, where `requireScopedSession`
      // would then throw and surface as a 500 on a page the user should simply
      // have been bounced off.
      //
      // So the gate asks for the two claims every downstream query actually
      // needs. Returning false sends them through the /login flow, which
      // re-mints a whole token instead of patching a broken one.
      //
      // WHAT `return false` PROMISES THE LOGIN PAGE (auth-017). next-auth's
      // middleware wrapper turns this into a redirect to `pages.signIn` and puts
      // the FULL original href in a `callbackUrl` query parameter
      // (node_modules/next-auth/lib/index.js:177). `app/login/page.tsx` reads it
      // back through `safePostLoginPath` so an emailed or bookmarked deep link
      // survives an expired session — it used to hard-navigate to /dashboard and
      // drop it. Two consequences worth knowing before editing this line:
      //   • returning a `NextResponse.redirect` of your own here INSTEAD of
      //     `false` would skip that entirely and lose the destination again;
      //   • the parameter is attacker-supplied by the time it reaches the login
      //     page, so it must never be followed unvalidated. That validation is
      //     lib/auth/post-login-redirect.ts, and it is the only reader.
      const claims = auth?.user;
      if (!claims?.id || !claims.companyId) return false;

      // Members can't see finance surfaces. Bounce them to their home
      // (/tasks) instead of throwing a 403 — the route is intentionally
      // invisible to them, so a silent redirect is the right UX.
      //
      // ASKED AS AN ALLOW-LIST (`!canSeeFinances`), NOT AS `role === "member"`.
      // The old comparison was the second fail-open in this function: any role
      // string that is not literally "member" fell through to `return true`, so
      // a token claiming `role: "accountant"` — a role somebody adds to
      // lib/auth/role-gates.ts next quarter, or one a tampered cookie invents —
      // reached the full company ledger. `roleFromToken` collapses anything
      // unrecognised to "member" and `canSeeFinances` is then the same
      // predicate /reports, the export route and the sidebar use, so widening
      // finance access stays a single edit in one file.
      //
      // WHAT THIS LAYER IS NOT. The Edge jwt callback below does no database
      // read, so `role` here is whatever was baked into the signed cookie at
      // sign-in — stale after a demotion until something re-mints the token
      // (which is why `updateUserRoleAction` now bumps `sessionVersion`). This
      // gate is therefore a UX redirect and a defence in depth, never the last
      // word: the page that READS money must re-check server-side, the way
      // app/(app)/reports/page.tsx does. Findings sec-002 / auth-003.
      //
      // Preserve the original querystring so an email link like
      // `/expenses?ref=newsletter` keeps `?ref=newsletter` when it lands
      // on /tasks. Drops nothing the user typed.
      const role = roleFromToken(claims.role);
      if (!canSeeFinances(role) && isMemberBlockedRoute(pathname)) {
        const dest = new URL(homeRouteForRole(role), request.nextUrl);
        dest.search = request.nextUrl.search;
        return NextResponse.redirect(dest);
      }
      return true;
    },
  },
} satisfies NextAuthConfig;
