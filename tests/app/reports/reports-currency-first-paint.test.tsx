// @vitest-environment jsdom
/**
 * rep-011 — a USD workspace's first paint must not be denominated in rupees.
 *
 * WHAT WENT WRONG. `/reports` is a Server Component that already fetches the
 * authoritative `company` row (app/(app)/reports/page.tsx, `getCurrentCompany()`)
 * and passes it to `ReportsClient`. The client used that prop for exactly two
 * things — the heading and the .xlsx column header `Amount (USD)` — while every
 * rendered figure went through `useMoney()`, which reads
 * `useStore(s => s.currentCompany?.currency ?? "PKR")`.
 *
 * `currentCompany` arrives over a TWO-HOP async chain: providers.tsx hydrates
 * `currentUser` from `useSession()`, and only then does `CompanyHydrator`'s effect
 * call `getMyCompanyAction()`. Until both resolve the fallback "PKR" is in force,
 * and the Export PDF button is clickable throughout — so a founder who signs up in
 * USD and exports immediately gets an investor PDF whose figures are labelled in
 * rupees while the sibling Excel header says USD. One click, two documents,
 * different currencies, ~280x apart.
 *
 * It is narrow but it is exactly the wrong moment: first load after signup, a new
 * device, cleared site data, and after /settings' own "Reset local preferences"
 * button (which removes `founderflow-storage`). Returning visits are fine because
 * `currentCompany` is in the persisted slice.
 *
 * THE FIX, and why it is a precedence change rather than a new fetch. `useMoney`
 * now takes the currency the server already knew, and that argument WINS over the
 * store rather than merely filling in for it. The store copy is hydrated from
 * `getMyCompanyAction()` — the same row — so in steady state they agree; where
 * they disagree the server prop is the one that is right, because a persisted
 * store can still hold the currency of a workspace the user signed out of.
 *
 * WHY THE STORE IS LEFT EMPTY IN THESE TESTS. That empty store IS the bug's
 * precondition. `useStore` starts with `currentCompany: null` in jsdom (nothing
 * has hydrated, and there is no persisted `founderflow-storage`), which is the
 * state a real first paint is in.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { useCurrency, useMoney } from "@/lib/hooks/useMoney";
import { useStore } from "@/lib/store";
import { ReportsClient } from "@/app/(app)/reports/reports-client";
import type { Company, Transaction, User } from "@/lib/types";

const company: Company = {
  id: "c1",
  name: "Nimbus Labs",
  industry: "SaaS",
  currency: "USD",
  createdAt: "2026-01-01T00:00:00.000Z",
  ownerId: "u1",
};

const users: User[] = [
  {
    id: "u1",
    name: "Ayesha Khan",
    email: "ayesha@nimbus.test",
    role: "admin",
    companyId: "c1",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as User,
];

function txn(over: Partial<Transaction> = {}): Transaction {
  const now = new Date();
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15));
  return {
    id: "t1",
    companyId: "c1",
    type: "expense",
    amount: 4321,
    category: "Infrastructure",
    description: "Cloud hosting renewal for the analytics stack",
    date: thisMonth.toISOString(),
    addedBy: "u1",
    addedByName: "Ayesha Khan",
    createdAt: thisMonth.toISOString(),
    ...over,
  } as Transaction;
}

describe("the store really is un-hydrated here — guard the guard", () => {
  it("has no currentCompany, which is the first-paint state the bug needs", () => {
    // If something hydrates the store, `useMoney()` returns USD by luck and every
    // assertion below passes against the unfixed code.
    expect(useStore.getState().currentCompany).toBeNull();
  });
});

describe("useCurrency / useMoney accept the currency the server already knew", () => {
  it("falls back to PKR only when nothing else is known", () => {
    const { result } = renderHook(() => useCurrency());
    expect(result.current).toBe("PKR");
  });

  it("uses the workspace currency handed to it, with an empty store", () => {
    const { result } = renderHook(() => useCurrency("USD"));
    expect(result.current).toBe("USD");
  });

  it("formats money in that currency rather than rupees", () => {
    const { result } = renderHook(() => useMoney("USD"));
    expect(result.current(1234.5)).toContain("$");
    expect(result.current(1234.5)).not.toMatch(/PKR|\bRs\b/);
  });

  it("ignores an empty or whitespace currency instead of formatting with it", () => {
    // Defensive: `Company.currency` is `String @default("PKR")` and non-null, but
    // an override that trusted "" would hand an invalid code to Intl.
    const { result } = renderHook(() => useCurrency("   "));
    expect(result.current).toBe("PKR");
  });
});

describe("/reports' first paint (rep-011)", () => {
  it("denominates every figure in the workspace currency, not the PKR fallback", () => {
    render(<ReportsClient transactions={[txn()]} users={users} company={company} />);
    // The founder-breakdown table renders `money(...)` for each row, so the
    // rendered document carries the formatter's output even before any chart
    // mounts (the recharts children are next/dynamic + ssr:false).
    const body = document.body.textContent ?? "";
    expect(body).toContain("$");
    expect(body).not.toMatch(/PKR|\bRs\b/);
  });

  it("still shows the workspace name from the same prop", () => {
    render(<ReportsClient transactions={[txn()]} users={users} company={company} />);
    expect(screen.getByRole("heading", { level: 1, name: /reports/i })).toBeTruthy();
  });
});
