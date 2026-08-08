"use client";

/**
 * Client-side money formatting bound to the workspace currency.
 *
 * The workspace currency lives on the store's `currentCompany` (hydrated once
 * per session by CompanyHydrator). Client components call `useMoney()` and use
 * the returned formatter instead of importing `formatCurrency` directly, so
 * every amount renders in the workspace's chosen currency. Falls back to PKR
 * until hydration lands (and for the demo/legacy persisted state).
 */

import { useCallback } from "react";
import { useStore } from "@/lib/store";
import { formatCurrency } from "@/lib/utils";

/** The workspace's currency code, or "PKR" until CompanyHydrator runs. */
export function useCurrency(): string {
  return useStore((s) => s.currentCompany?.currency ?? "PKR");
}

/** A `formatCurrency` bound to the workspace currency: `money(1234)`. */
export function useMoney(): (amount: number) => string {
  const currency = useCurrency();
  return useCallback((amount: number) => formatCurrency(amount, currency), [currency]);
}
