"use client";

/**
 * Client-side money formatting bound to the workspace currency.
 *
 * Two sources, in precedence order:
 *
 *  1. The currency a SERVER COMPONENT already fetched and handed down as a prop.
 *     Pass it. This is the authoritative value and it is available on the first
 *     paint.
 *  2. The store's `currentCompany.currency`, hydrated once per session by
 *     CompanyHydrator, for a client surface that has no such prop.
 *
 * and "PKR" only when neither is known.
 *
 * ── WHY THE ARGUMENT WINS RATHER THAN MERELY FILLING IN (rep-011) ────────────
 * `currentCompany` arrives over a two-hop async chain: components/providers.tsx
 * hydrates `currentUser` from `useSession()`, and only then does
 * components/layout/company-hydrator.tsx run its effect and call
 * `getMyCompanyAction()`. Until BOTH resolve this hook returned "PKR" — so a
 * workspace on any other currency rendered its first paint in rupees. On
 * /reports the Export PDF button is clickable throughout that window, and the
 * PDF is built from these formatted strings while the .xlsx header beside it
 * reads `Amount (USD)`: one click, two documents, currencies ~280x apart, in the
 * artefact this product sells as investor-ready.
 *
 * It hits on the first load after signup, on a new device, after clearing site
 * data, and after /settings' "Reset local preferences" (which removes
 * `founderflow-storage`). Returning visits were always fine, because
 * `currentCompany` is in the persisted slice — which is why it stayed invisible.
 *
 * Precedence, not fallback, because where the two disagree the prop is the one
 * that is right: both read the same row, but a PERSISTED store can still hold
 * the currency of a workspace the browser signed out of, and the prop was
 * fetched for this request.
 *
 * `useStore` is still subscribed unconditionally — a hook cannot be skipped — so
 * a surface that passes nothing behaves exactly as it did before.
 */

import { useCallback } from "react";
import { useStore } from "@/lib/store";
import { formatCurrency } from "@/lib/utils";

/**
 * The workspace's currency code.
 *
 * @param serverCurrency the currency from an RSC-supplied `company` row, when the
 * caller has one. Blank or whitespace is treated as absent rather than passed to
 * `Intl` — `Company.currency` is non-null with a "PKR" default, so a blank here
 * means a caller built a partial object, not that the workspace has no currency.
 */
export function useCurrency(serverCurrency?: string): string {
  const stored = useStore((s) => s.currentCompany?.currency);
  const fromServer = serverCurrency?.trim();
  if (fromServer) return fromServer;
  return stored ?? "PKR";
}

/** A `formatCurrency` bound to the workspace currency: `money(1234)`. */
export function useMoney(serverCurrency?: string): (amount: number) => string {
  const currency = useCurrency(serverCurrency);
  return useCallback((amount: number) => formatCurrency(amount, currency), [currency]);
}
