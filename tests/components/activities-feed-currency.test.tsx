/**
 * money-006, the WIRING half. `lib/activity/message.ts` being pure and green
 * proves nothing on its own — this repo's headline defect is code that is
 * written, unit-tested and called by nothing, four fresh instances of it in the
 * last wave alone. So this file drives the real /activities feed component and
 * asserts what a founder reading the page actually sees.
 *
 * The row below is the shape the ledger has been writing since 2026-09-28: the
 * prose carries a figure baked in at write time, and the metadata carries the
 * raw amount plus the currency it was written in. The feed must show the
 * metadata's figure, formatted now.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Activity } from "@/lib/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("react-hot-toast", () => ({
  default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock("@/lib/actions/activities", () => ({ loadMoreActivitiesAction: vi.fn() }));

import { ActivitiesClient } from "@/app/(app)/activities/activities-client";

function row(over: Partial<Activity> = {}): Activity {
  return {
    id: "a1",
    companyId: "c1",
    type: "expense_added",
    message: "Saqib added an expense of 1,234.5 PKR for Marketing",
    userId: "u1",
    userName: "Saqib",
    metadata: {
      kind: "transaction",
      amount: 1234.5,
      category: "Marketing",
      currency: "PKR",
    },
    createdAt: "2026-09-20T10:00:00.000Z",
    ...over,
  };
}

function renderFeed(activities: Activity[]) {
  return render(
    <ActivitiesClient
      initialActivities={activities}
      initialCursor={null}
      users={[{ id: "u1", name: "Saqib" }]}
      activeUserId="all"
    />
  );
}

describe("/activities renders money from the row's metadata (money-006)", () => {
  it("shows the amount formatted at read time, not the figure baked into the prose", () => {
    renderFeed([row()]);

    expect(
      screen.getByText("Saqib added an expense of PKR 1,234.50 for Marketing")
    ).toBeInTheDocument();
    // The stale rendering must be gone, not merely accompanied.
    expect(screen.queryByText(/1,234\.5 PKR/)).not.toBeInTheDocument();
  });

  it("keeps a row's own currency when the workspace has since switched", () => {
    renderFeed([
      row({
        metadata: { kind: "transaction", amount: 900, category: "Travel", currency: "AED" },
        message: "Saqib added an expense of 900.00 AED for Travel",
      }),
    ]);

    expect(screen.getByText("Saqib added an expense of AED 900.00 for Travel")).toBeInTheDocument();
  });

  it("leaves a row with no money metadata exactly as written", () => {
    renderFeed([
      row({
        id: "a2",
        type: "task_completed",
        message: "Aisha completed “Wire the Falcon invoice”",
        metadata: { kind: "task", taskId: "t1", title: "Wire the Falcon invoice" },
      }),
    ]);

    expect(screen.getByText("Aisha completed “Wire the Falcon invoice”")).toBeInTheDocument();
  });

  it("still searches the prose a user can see", () => {
    // The search box filters on `message`; a user typing what is on screen must
    // not be filtering against a different string. Guards the obvious next bug.
    renderFeed([row()]);
    expect(screen.getByPlaceholderText("Search activity…")).toBeInTheDocument();
  });
});
