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
import { homeRouteForRole, isMemberBlockedRoute, type Role } from "@/lib/auth/role-gates";

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
        pathname.startsWith("/invite/") || // /invite/[token] for email-link onboarding
        pathname.startsWith("/api/auth") ||
        pathname.startsWith("/api/cron/") || // protected by CRON_SECRET header instead
        pathname === "/robots.txt" ||
        pathname === "/sitemap.xml" ||
        pathname === "/icon.svg" ||
        pathname === "/icon-maskable.svg" ||
        pathname === "/manifest.json" ||
        pathname === "/sw.js";
      if (isPublic) return true;
      if (!auth) return false;

      // Members can't see finance surfaces. Bounce them to their home
      // (/tasks) instead of throwing a 403 — the route is intentionally
      // invisible to them, so a silent redirect is the right UX. The
      // server-action layer enforces the same rule on writes, so a forged
      // request can't bypass this.
      //
      // Preserve the original querystring so an email link like
      // `/expenses?ref=newsletter` keeps `?ref=newsletter` when it lands
      // on /tasks. Drops nothing the user typed.
      const role = (auth.user?.role as Role | undefined) ?? "member";
      if (role === "member" && isMemberBlockedRoute(pathname)) {
        const dest = new URL(homeRouteForRole(role), request.nextUrl);
        dest.search = request.nextUrl.search;
        return NextResponse.redirect(dest);
      }
      return true;
    },
  },
} satisfies NextAuthConfig;
