/**
 * Auth middleware (Edge runtime).
 *
 * Pulls in ONLY the Edge-safe base config from auth.config.ts so Prisma and
 * bcrypt (Node-only) never reach the Edge bundle. The full config in
 * lib/auth.ts is used for server actions + the /api/auth/* route handler.
 *
 * Closes audit flaw #3 — protected routes are blocked server-side before any
 * page renders. The old client-side guard in app/(app)/layout.tsx is now
 * dead code that we'll trim once we're confident.
 */

import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // Match everything except Next.js internals + static assets. The
  // `authorized()` callback in auth.config.ts decides allow vs. redirect.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.json|robots.txt|sitemap.xml|.*\\..*).*)",
  ],
};
