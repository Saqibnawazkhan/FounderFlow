/**
 * What "select all" on the task list means — the pure decision, separated from
 * the board that renders it.
 *
 * SECOND HALF OF tasks-and-comments-010. `toggleSelectAll` in
 * app/(app)/tasks/tasks-client.tsx selected every FILTERED id with no ceiling,
 * while `BulkTaskStatusSchema` and `BulkTaskDeleteSchema` cap `ids` at
 * `MAX_BULK_TASK_IDS`. The default board window is `TASK_PAGE_SIZE` = 300
 * (lib/queries/tasks.ts), deliberately ABOVE that cap — so this was not a
 * big-customer hypothetical: ONE page of a busy workspace reaches it, and there
 * the headline bulk feature's only possible outcome was a refusal.
 * lib/actions/tasks.ts made that refusal a sentence instead of zod's "Array must
 * contain at most 200 element(s)"; this stops the UI producing the illegal
 * request in the first place.
 *
 * WHY THIS IS A MODULE AND NOT TWO LINES INSIDE THE COMPONENT. The property
 * worth pinning only shows up above 200 rows, and 200+ board rows in jsdom —
 * each with a status `<select>`, an avatar and a dnd-kit sortable — is minutes
 * per interaction, which is how a suite acquires a test nobody dares run. Same
 * reasoning as `taskScopeWhere` in lib/queries/tasks.ts and
 * `sessionTokenStillValid` in lib/auth/session-version.ts: put the rule
 * somewhere it can be read, and tested, without the machinery around it.
 *
 * Tested in tests/components/tasks/bulk-selection.test.ts.
 */

import { MAX_BULK_TASK_IDS } from "@/lib/schemas/task";

/**
 * How many of `filteredCount` rows one select-all may actually take.
 *
 * This — not `filteredCount` — is what the header checkbox's `checked` and
 * `indeterminate` states must compare against. Against the filtered total, a
 * board above the cap leaves the box permanently indeterminate: `checked` is
 * unreachable, and the "already everything is selected, so clear it" test can
 * never become true, so a second click re-selects instead of clearing.
 */
export function selectableTaskCount(filteredCount: number): number {
  return Math.min(Math.max(0, filteredCount), MAX_BULK_TASK_IDS);
}

/**
 * The next selection after the select-all checkbox is clicked: the first
 * `MAX_BULK_TASK_IDS` filtered ids, or none when that many are already held.
 *
 * Takes the ids in the order the list shows them and slices from the front, so
 * "the first 200" means the first 200 the reader can see rather than an
 * arbitrary 200 — which is the only version of the clamp that can be explained
 * on screen.
 */
export function nextSelectAllIds(filteredIds: readonly string[], selectedCount: number): string[] {
  if (selectedCount === selectableTaskCount(filteredIds.length)) return [];
  return filteredIds.slice(0, MAX_BULK_TASK_IDS);
}

/**
 * Whether the live selection is smaller than the filter it came from — i.e.
 * whether the board owes the reader the "first N of M" line.
 *
 * A silent clamp is its own bug: they pressed one checkbox over a 300-row
 * filter, and without this they would read "200 selected" as the whole set and
 * believe the other 100 were about to move too.
 */
export function selectionWasClamped(filteredCount: number, selectedCount: number): boolean {
  return selectedCount > 0 && filteredCount > MAX_BULK_TASK_IDS;
}
