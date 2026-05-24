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

import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { authConfig } from "@/auth.config";
import { db } from "@/lib/db";

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
    companyId?: string;
    role?: "admin" | "cofounder" | "member";
  }
}

export const { auth, handlers, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;

        const user = await db.user.findUnique({
          where: { email: email.toLowerCase() },
        });
        if (!user) return null;

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;

        // Stamp last-sign-in for the /settings audit row. Fire-and-forget
        // is fine — a logged-in user shouldn't see auth() fail because
        // the timestamp didn't land. We swallow errors to keep auth resilient
        // (it's defensive — bad password is the only realistic block here).
        db.user
          .update({ where: { id: user.id }, data: { lastSignInAt: new Date() } })
          .catch(() => {});

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          companyId: user.companyId,
          role: user.role as "admin" | "cofounder" | "member",
        };
      },
    }),
  ],
});
