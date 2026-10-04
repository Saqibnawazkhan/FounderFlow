/**
 * "Select all" must not build a request the server is certain to refuse.
 * Finding tasks-and-comments-010, second half.
 *
 * WHAT WAS WRONG. `toggleSelectAll` in app/(app)/tasks/tasks-client.tsx was
 *
 *     setSelected((prev) =>
 *       prev.size === filtered.length ? new Set() : new Set(filtered.map((t) => t.id))
 *     );
 *
 * — every filtered id, no ceiling — while `BulkTaskStatusSchema` and
 * `BulkTaskDeleteSchema` cap `ids` at `MAX_BULK_TASK_IDS`. The board's default
 * window is `TASK_PAGE_SIZE` = 300 (lib/queries/tasks.ts), chosen to sit ABOVE
 * that cap, so a single page of a busy workspace already exceeded it: one click
 * on the header checkbox, and every bulk control was an error message.
 * lib/actions/tasks.ts turned that message from zod's "Array must contain at
 * most 200 element(s)" into a sentence (covered by
 * tests/lib/actions/bulk-task-selection-limit.test.ts, whose header records this
 * clamp as the piece left over) — but a primary control whose only outcome is an
 * error is still broken.
 *
 * WHY THESE ARE UNIT CASES AND NOT CLICKS ON THE BOARD. The behaviour under test
 * only exists above 200 rows, and 200 board rows in jsdom — each with a status
 * `<select>`, an avatar and a dnd-kit sortable — costs minutes per interaction.
 * That was measured, not assumed: the first draft of this coverage was six
 * userEvent cases over a 210-row board and it had not finished after ten
 * minutes. A test nobody dares run is not a pin, so the rule moved into
 * components/tasks/bulk-selection.ts, where it can be read on its own.
 *
 * THE CAP IS DISCOVERED, NOT TYPED. Every case below asks the real schema what
 * its ceiling is, the same way the action's test does, so this file cannot sit
 * green while promising 200 against a parser that rejects at 150.
 */

import { describe, expect, it } from "vitest";
import {
  nextSelectAllIds,
  selectableTaskCount,
  selectionWasClamped,
} from "@/components/tasks/bulk-selection";
import { BulkTaskDeleteSchema, BulkTaskStatusSchema, MAX_BULK_TASK_IDS } from "@/lib/schemas/task";

function ids(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`t_${i}`);
  return out;
}

/** The largest `ids` array the real parser accepts — probed, not hard-coded. */
function schemaCap(): number {
  for (let n = 1; n <= 2000; n++) {
    if (!BulkTaskStatusSchema.safeParse({ ids: ids(n), status: "pending" }).success) return n - 1;
  }
  throw new Error("BulkTaskStatusSchema has no ids ceiling at all");
}

describe("tasks-and-comments-010 — select-all clamps to one legal request", () => {
  it("never selects more than the bulk actions accept", () => {
    const cap = schemaCap();
    const picked = nextSelectAllIds(ids(cap + 50), 0);

    expect(picked).toHaveLength(cap);
    // The decisive assertion: the payload goes through the parser the action
    // actually runs. An off-by-one here is the whole finding.
    expect(
      BulkTaskStatusSchema.safeParse({ ids: picked, status: "completed" }).success,
      "select-all built a payload BulkTaskStatusSchema rejects"
    ).toBe(true);
    expect(
      BulkTaskDeleteSchema.safeParse({ ids: picked }).success,
      "select-all built a payload BulkTaskDeleteSchema rejects"
    ).toBe(true);
  });

  it("takes the first N in list order, so 'the first 200' is what the reader sees", () => {
    const cap = schemaCap();
    const picked = nextSelectAllIds(ids(cap + 50), 0);

    expect(picked[0]).toBe("t_0");
    expect(picked[cap - 1]).toBe(`t_${cap - 1}`);
  });

  it("still selects the whole filter when it fits", () => {
    // GUARDS THE GUARD. A clamp that always returned exactly `cap` ids, or one
    // that returned nothing at all, would satisfy the two cases above.
    expect(nextSelectAllIds(ids(4), 0)).toEqual(["t_0", "t_1", "t_2", "t_3"]);
    expect(nextSelectAllIds([], 0)).toEqual([]);
  });

  it("clears a clamped selection on the second click", () => {
    // The stuck-checkbox bug. The toggle's "everything is already selected"
    // test has to compare against the SELECTABLE count: against the filtered
    // total it can never become true above the cap, so a second click
    // re-selects and the reader cannot clear the bar.
    const cap = schemaCap();
    expect(
      nextSelectAllIds(ids(cap + 50), cap),
      "a clamped select-all could not be undone"
    ).toEqual([]);
  });

  it("clears an unclamped selection on the second click too", () => {
    expect(nextSelectAllIds(ids(4), 4)).toEqual([]);
  });

  it("re-selects from a partial selection rather than clearing it", () => {
    const cap = schemaCap();
    // Three rows ticked by hand on a big board: the header checkbox is
    // indeterminate, and clicking it must fill the selection, not empty it.
    expect(nextSelectAllIds(ids(cap + 50), 3)).toHaveLength(cap);
  });
});

describe("selectableTaskCount — what the header checkbox compares against", () => {
  it("is the cap on a board above it, and the row count below", () => {
    const cap = schemaCap();
    expect(selectableTaskCount(cap + 50)).toBe(cap);
    expect(selectableTaskCount(7)).toBe(7);
    expect(selectableTaskCount(0)).toBe(0);
  });

  it("agrees with the constant the parser and the action's message use", () => {
    // Three places need this number — the parser, `bulkSelectionTooLargeError`
    // in lib/actions/tasks.ts, and this clamp. It is one exported constant now
    // rather than three literals; this is the assertion that says so.
    expect(selectableTaskCount(Number.MAX_SAFE_INTEGER)).toBe(MAX_BULK_TASK_IDS);
    expect(MAX_BULK_TASK_IDS).toBe(schemaCap());
  });
});

describe("selectionWasClamped — the reader is told when it happened", () => {
  it("is true when the filter is bigger than the cap and something is selected", () => {
    const cap = schemaCap();
    expect(selectionWasClamped(cap + 50, cap)).toBe(true);
  });

  it("is false with nothing selected, so the bar does not explain an empty state", () => {
    const cap = schemaCap();
    expect(selectionWasClamped(cap + 50, 0)).toBe(false);
  });

  it("is false when the whole filter fits, so a normal board says nothing extra", () => {
    expect(selectionWasClamped(4, 4)).toBe(false);
    expect(selectionWasClamped(MAX_BULK_TASK_IDS, MAX_BULK_TASK_IDS)).toBe(false);
  });
});
