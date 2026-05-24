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
        pathname.startsWith("/login") ||
        pathname.startsWith("/signup") ||
        pathname.startsWith("/invite/") || // /invite/[token] for email-link onboarding
        pathname.startsWith("/api/auth") ||
        pathname === "/robots.txt" ||
        pathname === "/sitemap.xml" ||
        pathname === "/icon.svg" ||
        pathname === "/manifest.json";
      return isPublic || !!auth;
    },
  },
} satisfies NextAuthConfig;
