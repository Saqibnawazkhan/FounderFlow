/**
 * /budgets — Server Component. Fetches every budget for the company along
 * with current-month spend per category, then hands a flat list to the
 * client child for rendering + management.
 */

import type { Metadata } from "next";
import { getBudgetsWithSpend } from "@/lib/queries/budgets";
import { BudgetsClient } from "./budgets-client";

export const metadata: Metadata = {
  title: "Budgets",
  description: "Set monthly per-category spending caps. Warnings fire at 80% and alerts at 100%.",
};

export default async function BudgetsPage() {
  const budgets = await getBudgetsWithSpend();
  return <BudgetsClient budgets={budgets} />;
}
