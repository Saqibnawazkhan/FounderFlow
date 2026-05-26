/**
 * /budgets — Server Component. Fetches every budget for the company along
 * with current-month spend per category, then hands a flat list to the
 * client child for rendering + management.
 */

import type { Metadata } from "next";
import { getBudgetsWithSpend } from "@/lib/queries/budgets";
import { listProjectOptions } from "@/lib/queries/projects";
import { BudgetsClient } from "./budgets-client";

export const metadata: Metadata = {
  title: "Budgets",
  description: "Set monthly per-category spending caps. Warnings fire at 80% and alerts at 100%.",
};

export default async function BudgetsPage() {
  const [budgets, projects] = await Promise.all([getBudgetsWithSpend(), listProjectOptions()]);
  return (
    <BudgetsClient budgets={budgets} projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
  );
}
