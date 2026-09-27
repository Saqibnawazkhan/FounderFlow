/**
 * Node-runtime Auth.js wiring. Extends the Edge-safe base config in
 * auth.config.ts with the Credentials provider (which calls bcrypt + Prisma
 * — both Node-only). Exported helpers:
 *   - auth: read the session in server components / actions
 *   - handlers: GET + POST for /api/auth/[...nextauth]
 *   - signIn / signOut: callable from server actions
 *
 * Type augmentations live here (alongside Credentials) so the @auth/core/jwt
 * import stays out of the Edge bundle.
 */

import NextAuth, { type DefaultSession, type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { authConfig } from "@/auth.config";
import { db } from "@/lib/db";
import { captureServerError } from "@/lib/sentry-server";
import { sessionTokenStillValid } from "@/lib/auth/session-version";
import { gateLoginAttempt, recordLoginFailure } from "@/lib/auth/login-throttle";
import { getClientIp } from "@/lib/client-ip";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      companyId: string;
      role: "admin" | "cofounder" | "member";
    } & DefaultSession["user"];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id?: string;
    companyId?: string;
    role?: "admin" | "cofounder" | "member";
    // Snapshot of the user's sessionVersion at sign-in; re-checked per request.
    sessionVersion?: number;
  }
}

// Node-runtime config, minus providers — those are attached at the bottom,
// after authorizeCredentials is defined.
const nodeAuthConfig: NextAuthConfig = {
  ...authConfig,
  callbacks: {
    // Preserve the Edge-safe session + authorized callbacks; override jwt with
    // a Node version that re-validates against the DB. This runs on every
    // auth() call (server components AND actions) — the single choke point
    // that covers reads and writes — but NOT in middleware, which uses the
    // Edge config's DB-free jwt callback.
    ...authConfig.callbacks,
    async jwt({ token, user }) {
      // Sign-in: stamp identity + the session-version snapshot, no DB read.
      if (user) {
        token.id = (user as { id: string }).id;
        token.companyId = (user as { companyId?: string }).companyId;
        token.role = (user as { role?: "admin" | "cofounder" | "member" }).role;
        token.sessionVersion = (user as { sessionVersion?: number }).sessionVersion ?? 0;
        return token;
      }

      // No id to validate against (shouldn't happen post-sign-in) — leave as-is.
      if (!token.id) return token;

      try {
        const current = await db.user.findUnique({
          where: { id: token.id },
          select: { deletedAt: true, sessionVersion: true, role: true, companyId: true },
        });
        // Gone, tombstoned, or version bumped → kill the session now instead
        // of waiting for the cookie to expire.
        if (!current || !sessionTokenStillValid(token.sessionVersion, current)) {
          return null;
        }
        // Keep role/company fresh so a role change also takes effect at once.
        token.role = current.role as "admin" | "cofounder" | "member";
        token.companyId = current.companyId;
        return token;
      } catch (e) {
        // Fail OPEN on a transient DB error: the token is still
        // cryptographically valid, and signing every user out on a blip is
        // worse than the brief window a just-invalidated session lingers.
        captureServerError(e, {
          action: "jwtSessionRevalidate",
          extra: { userId: String(token.id) },
        });
        return token;
      }
    },
  },
};

/**
 * The Credentials provider's authorize() callback, lifted out of the provider
 * literal into a named export.
 *
 * WHY IT IS A NAMED EXPORT: this function is the single choke point every
 * password check funnels through — the login form (loginAction -> signIn) AND
 * the raw `POST /api/auth/callback/credentials`, which auth.config.ts marks
 * PUBLIC and which needs nothing but a csrfToken from the public
 * `GET /api/auth/csrf`. NextAuth exposes no handle on a provider's authorize
 * once it is constructed, so without this export there is no way to write a
 * test that proves the throttle below is still wired into the path an attacker
 * actually uses. That proof is the whole point: the previous version of this
 * file carried a comment asserting the rate limiter covered this path when it
 * did not.
 */
export async function authorizeCredentials(raw: unknown) {
  const parsed = credentialsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { email, password } = parsed.data;

  // THROTTLE FIRST — before the lookup, before bcrypt. This is the gate that
  // used to live only in loginAction and therefore covered only the form; see
  // lib/auth/login-throttle.ts for why that was a P0. getClientIp() works here
  // for the same reason it works in a server action: authorize() runs in the
  // Node runtime inside a request scope, whether it was reached through
  // signIn() from loginAction or straight through the public
  // /api/auth/callback/credentials route handler.
  //
  // Returning null (rather than throwing) is what keeps this invisible: it
  // surfaces as the same CredentialsSignin error a wrong password does, so
  // there is no new UI copy and no oracle telling an attacker which of the two
  // happened — or whether the address exists at all.
  const throttle = gateLoginAttempt(await getClientIp(), email);
  if (!throttle.allowed) return null;

  // findFirst instead of findUnique so we can add the deletedAt filter.
  // Soft-deleted users (Tier 3) MUST not be able to sign back in —
  // that's the whole point of tombstoning them.
  const user = await db.user.findFirst({
    where: { email: email.toLowerCase(), deletedAt: null },
  });
  if (!user) {
    // Charge the account bucket even for an address with no row — see
    // recordLoginFailure. Guessing addresses must not be the cheap path.
    recordLoginFailure(email);
    return null;
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    recordLoginFailure(email);
    // A failed compare on an EXISTING user is the brute-force signal:
    // someone knows a real email and is trying passwords. Capture
    // (no full email — that'd leak PII into Sentry + enable account
    // enumeration via Sentry); userId + hash prefix is enough to
    // trend it. Forgotten-password typos by legit users land here too —
    // accept that noise floor.
    captureServerError(new Error("Credentials rejected after user lookup"), {
      action: "authorizeCredentials",
      extra: { userId: user.id, hashPrefix: user.passwordHash.slice(0, 7) },
    });
    return null;
  }

  // Stamp last-sign-in for the /settings audit row. Fire-and-forget
  // so a DB blip on the timestamp doesn't block the login itself —
  // but we DO log failures: a silent rot here means the rogue-login
  // detection on /settings becomes unreliable, and we'd never know.
  db.user
    .update({ where: { id: user.id }, data: { lastSignInAt: new Date() } })
    .catch((e: unknown) =>
      captureServerError(e, {
        action: "updateLastSignInAt",
        extra: { userId: user.id },
      })
    );

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    companyId: user.companyId,
    role: user.role as "admin" | "cofounder" | "member",
    // Snapshot the version so the jwt callback can detect a later bump.
    sessionVersion: user.sessionVersion,
  };
}

export const { auth, handlers, signIn, signOut } = NextAuth({
  ...nodeAuthConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: authorizeCredentials,
    }),
  ],
});
