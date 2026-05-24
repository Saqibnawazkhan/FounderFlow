/**
 * Read-side queries for the caller's company record. Used to drop the
 * `companies` array out of the Zustand store — the only reason that store
 * field existed was to render the company name/industry in the sidebar.
 */

import { db } from "@/lib/db";
import { requireScopedSession } from "@/lib/queries/session";
import type { Company } from "@/lib/types";

function toClient(c: {
  id: string;
  name: string;
  industry: string;
  currency: string;
  ownerId: string | null;
  createdAt: Date;
}): Company {
  return {
    id: c.id,
    name: c.name,
    industry: c.industry,
    currency: c.currency,
    ownerId: c.ownerId ?? "",
    createdAt: c.createdAt.toISOString(),
  };
}

export async function getCurrentCompany(): Promise<Company> {
  const { companyId } = await requireScopedSession();
  const row = await db.company.findUnique({ where: { id: companyId } });
  if (!row) throw new Error("Company not found");
  return toClient(row);
}
