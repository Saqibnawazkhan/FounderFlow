"use server";

/**
 * Auth server actions. Replace the localStorage-based signup/login that
 * lived in the Zustand store with real Prisma + bcrypt + Auth.js (closes
 * audit flaws #1, #2, #5).
 *
 * - signupAction: validates input with zod, hashes the password with bcrypt,
 *   creates Company + User atomically, then sets the Auth.js session cookie
 *   via signIn("credentials", ...). UI redirects to /dashboard on success.
 * - loginAction: thin wrapper around signIn so we can return a typed result
 *   instead of letting NextAuth throw a redirect.
 *
 * Both return { success: boolean; error?: string }. UI calls them with
 * useTransition for the loading state.
 */

import { z } from "zod";
import bcrypt from "bcryptjs";
import { AuthError } from "next-auth";
import { signIn, signOut } from "@/lib/auth";
import { db } from "@/lib/db";

const SignupSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters").max(120),
  companyName: z.string().trim().min(1, "Company name is required").max(80),
  industry: z.string().trim().min(1).max(80),
});

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export type ActionResult = { success: boolean; error?: string };

export async function signupAction(input: unknown): Promise<ActionResult> {
  const parsed = SignupSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { name, email, password, companyName, industry } = parsed.data;

  // Reject duplicate emails up front so the user sees a useful message
  // instead of a generic Prisma constraint violation.
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return { success: false, error: "An account with this email already exists" };
  }

  const passwordHash = await bcrypt.hash(password, 12);

  // Two-step inside a transaction to break the User <-> Company circular FK
  // (Company.ownerId is nullable; we backfill it after the user is created).
  await db.$transaction(async (tx) => {
    const company = await tx.company.create({
      data: { name: companyName, industry, currency: "PKR" },
    });
    const user = await tx.user.create({
      data: {
        name,
        email,
        passwordHash,
        role: "admin",
        companyId: company.id,
      },
    });
    await tx.company.update({
      where: { id: company.id },
      data: { ownerId: user.id },
    });
    await tx.activity.create({
      data: {
        companyId: company.id,
        type: "company_created",
        message: `${name} created the company "${companyName}"`,
        userId: user.id,
        userName: name,
      },
    });
  });

  // signIn with redirect:false so the caller controls the navigation; if
  // we let it redirect, the server action throws and the client never gets
  // the success result.
  try {
    await signIn("credentials", { email, password, redirect: false });
  } catch (e) {
    if (e instanceof AuthError) {
      return { success: false, error: "Account created but sign-in failed. Try logging in." };
    }
    throw e;
  }

  return { success: true };
}

export async function loginAction(input: unknown): Promise<ActionResult> {
  const parsed = LoginSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Email and password are required" };
  }
  const { email, password } = parsed.data;

  try {
    await signIn("credentials", { email, password, redirect: false });
    return { success: true };
  } catch (e) {
    if (e instanceof AuthError) {
      return { success: false, error: "Invalid email or password" };
    }
    throw e;
  }
}

export async function logoutAction(): Promise<void> {
  await signOut({ redirect: false });
}
