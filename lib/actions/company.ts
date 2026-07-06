"use server";

/**
 * Company info mutation — name, industry, currency. Admin + cofounder only.
 *
 * Scope: there's exactly one company per session (session.user.companyId)
 * and the caller is always editing their own. We don't accept an arbitrary
 * companyId — preventing cross-company writes via forged input.
 */

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { UpdateCompanySchema } from "@/lib/schemas/company";
import { limiters } from "@/lib/rate-limit";
import { canSeeFinances, type Role } from "@/lib/auth/role-gates";
import { captureServerError } from "@/lib/sentry-server";
import { getCurrentCompany } from "@/lib/queries/company";

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string };

export async function updateCompanyAction(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.companyId || !session.user.id) {
    return { success: false, error: "Not authenticated" };
  }
  if (!canSeeFinances(session.user.role as Role)) {
    return { success: false, error: "Only admins and cofounders can edit company info" };
  }
  const gate = limiters.write.consume(session.user.id);
  if (!gate.allowed) return { success: false, error: gate.error ?? "Too many requests" };

  const parsed = UpdateCompanySchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid company info" };
  }
  const { name, industry, currency } = parsed.data;

  try {
    await db.company.update({
      where: { id: session.user.companyId },
      data: { name, industry, currency },
    });
    // Revalidate everywhere the company info shows: sidebar header,
    // settings, dashboard banner (if present), reports footer.
    revalidatePath("/settings");
    revalidatePath("/dashboard");
    revalidatePath("/reports");
    return { success: true, data: undefined };
  } catch (e) {
    captureServerError(e, { action: "updateCompanyAction" });
    return { success: false, error: "Couldn't update company info right now." };
  }
}

/**
 * Read the caller's company name + industry for the sidebar header. Thin
 * wrapper over the getCurrentCompany query so CompanyHydrator (a Client
 * Component) can fetch it. Returns an error result instead of throwing when
 * unauthenticated so the hydrator can quietly no-op.
 */
export async function getMyCompanyAction(): Promise<
  ActionResult<{ name: string; industry: string }>
> {
  try {
    const company = await getCurrentCompany();
    return { success: true, data: { name: company.name, industry: company.industry } };
  } catch {
    return { success: false, error: "Couldn't load company info" };
  }
}
