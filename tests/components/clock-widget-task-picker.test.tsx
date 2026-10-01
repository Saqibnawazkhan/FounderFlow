/**
 * <ClockWidget> — the clock-in picker admits when it is showing a subset.
 *
 * time-013's server half is `getOpenEntryAction` returning `tasksTruncated` from a
 * has-more probe. This file is the half that a customer can see: a flag in a
 * payload that no component renders is this repo's signature defect, and the
 * picker's whole problem was that its ceiling was invisible.
 *
 * It also pins the negative case. A hint that renders unconditionally is
 * decoration, and worse than none — it would tell every workspace with four tasks
 * that tasks are missing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const H = vi.hoisted(() => ({
  tasks: { value: [] as { id: string; title: string }[] },
  truncated: { value: false },
}));

vi.mock("@/lib/actions/time", () => ({
  getOpenEntryAction: async () => ({
    success: true,
    data: { openEntry: null, tasks: H.tasks.value, tasksTruncated: H.truncated.value },
  }),
  heartbeatAction: async () => ({ success: true, data: undefined }),
  clockInAction: async () => ({ success: true, data: { entryId: "x" } }),
  clockOutAction: async () => ({ success: true, data: undefined }),
  autoCloseEntryAction: async () => ({ success: true, data: undefined }),
}));
const stableRouter = { refresh: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => stableRouter }));
vi.mock("@/lib/i18n/use-t", () => ({
  useNumberFormat: () => ({ number: (v: number) => String(v) }),
}));
vi.mock("react-hot-toast", () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});

import { ClockWidget } from "@/components/time/clock-widget";

beforeEach(() => {
  H.tasks.value = [
    { id: "t1", title: "Ship the invoice screen" },
    { id: "t2", title: "Fix the runway card" },
  ];
  H.truncated.value = false;
});

afterEach(() => vi.clearAllMocks());

async function openStartModal() {
  render(<ClockWidget />);
  const pill = await waitFor(() => screen.getByRole("button", { name: "Clock in" }));
  await userEvent.click(pill);
  return waitFor(() => screen.getByRole("combobox"));
}

describe("ClockWidget — the task picker's ceiling", () => {
  it("says the list is a subset when the workspace has more open tasks", async () => {
    H.truncated.value = true;
    const select = await openStartModal();

    const hint = await screen.findByText(/most recently created open tasks/i);
    expect(hint.textContent).toMatch(/older ones aren't listed/i);
    // The hint is wired to the control, not just floating next to it.
    expect(select.getAttribute("aria-describedby")).toBe(hint.id);
  });

  it("says nothing when every open task is in the list", async () => {
    H.truncated.value = false;
    const select = await openStartModal();

    expect(screen.queryByText(/most recently created open tasks/i)).toBeNull();
    expect(select.getAttribute("aria-describedby")).toBeNull();
  });
});
