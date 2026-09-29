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

/**
 * A real bcrypt digest at cost 12, held constant, that no account is stored
 * against. It exists so the "no such address" branch of `authorizeCredentials`
 * can pay the same ~250ms bcrypt bill the "wrong password" branch pays.
 *
 * WHY (audit auth-011). `POST /api/auth/callback/credentials` is public
 * (auth.config.ts) and needs nothing but a csrfToken from the public
 * `GET /api/auth/csrf`. While the miss branch returned straight after the
 * lookup, the response time answered a question the product otherwise refuses
 * to answer: a registered address cost a bcrypt compare, an unregistered one
 * cost one indexed SELECT. `/forgot-password` is deliberately
 * enumeration-proof (lib/actions/password-reset.ts) and `loginAction` returns a
 * deliberately neutral "Invalid email or password"; both were undone by a
 * stopwatch. It leaked the tombstone too — the lookup filters
 * `deletedAt: null`, so a DELETED account took the fast branch and was
 * distinguishable from a live one.
 *
 * THE COST FACTOR IS THE WHOLE POINT and it must track the real one. Every
 * stored hash in this repo is written at 12 (`bcrypt.hash(password, 12)` in
 * lib/actions/auth.ts, lib/actions/password-reset.ts, lib/actions/profile.ts,
 * lib/actions/team.ts). A sentinel at a lower cost would leave a proportional
 * split still readable; a higher one inverts it. The cost lives inside the
 * digest string, so it cannot be read off this file's imports —
 * tests/lib/auth/login-throttle.test.ts parses every `bcrypt.hash` call under
 * `lib/` and asserts the sentinel's embedded cost equals all of them, so
 * changing one without the other fails the suite.
 *
 * ITS PLAINTEXT IS IRRELEVANT. The comparison's result is discarded, never
 * branched on, so even if this exact digest's plaintext were published it
 * unlocks nothing — which is why a hard-coded constant is correct here and
 * hashing something per request is not: that would cost a hash PLUS a compare,
 * i.e. double the known-address path, reopening the split with the sign flipped.
 *
 * THE COST OF THIS MITIGATION, STATED. An unknown-address guess now burns a
 * bcrypt(12) where it used to burn a SELECT. What bounds that is the gate
 * above it: `gateLoginAttempt` refuses before the lookup, so only attempts
 * already inside the 5-per-IP-per-minute budget buy the work. Pinned by
 * "buys that bcrypt only for attempts the throttle has already allowed".
 */
const ABSENT_ACCOUNT_PASSWORD_HASH = "$2b$12$shPflmLrcgvYvZfMmyYGIe/rYKzyj5QqfazIzrS3dgK17NO4mcDP.";

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
          // `name` and `email` joined this select for acct-006. They cost
          // nothing — this lookup already runs on every auth() call, for the
          // tombstone/version check below — and without them the two fields
          // were stamped once at sign-in and never read again, so a display-name
          // change reached the /settings body and nothing else: not the sidebar,
          // not the top bar, and not requireScopedSession().userName/.email on
          // the server.
          select: {
            deletedAt: true,
            sessionVersion: true,
            role: true,
            companyId: true,
            name: true,
            email: true,
          },
        });
        // Gone, tombstoned, or version bumped → kill the session now instead
        // of waiting for the cookie to expire.
        if (!current || !sessionTokenStillValid(token.sessionVersion, current)) {
          return null;
        }
        // Keep role/company fresh so a role change also takes effect at once.
        token.role = current.role as "admin" | "cofounder" | "member";
        token.companyId = current.companyId;
        // Same reasoning, one finding later (acct-006): the identity the app
        // renders has to be the identity in the database. Written only on this
        // path, AFTER the validity check and inside the try, so the fail-open
        // branch below still returns the token exactly as it arrived rather
        // than one whose name has been overwritten with `undefined`.
        token.name = current.name;
        token.email = current.email;
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
    // Ordered FIRST so the throttle accounting can never be skipped by
    // something the comparison below does; it is an in-memory Map write, so
    // the ordering costs nanoseconds against the ~250ms that follows.
    recordLoginFailure(email);
    // auth-011: pay the SAME bcrypt bill this function pays on the
    // wrong-password branch, so the response time stops answering "is this
    // address registered?". See ABSENT_ACCOUNT_PASSWORD_HASH above for why the
    // digest is a constant, why its cost factor is load-bearing, and why the
    // discarded result is safe.
    await bcrypt.compare(password, ABSENT_ACCOUNT_PASSWORD_HASH);
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
