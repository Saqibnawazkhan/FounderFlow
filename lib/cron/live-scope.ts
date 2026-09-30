/**
 * The one statement of "which rows may a background job touch" (cron-010).
 *
 * Tier 3 made deletion recoverable: `deleteWorkspaceAction` writes a tombstone
 * and `/api/cron/purge-soft-deleted` collects it 90 days later. For those 90
 * days the rows are still there, and anything that WRITES to them is editing
 * data an operator may still restore — so the restored workspace does not match
 * what the customer had when they deleted it.
 *
 * Every nightly job therefore needs this filter, and until 2026-09-30 they did
 * not agree about it. The materializer had it and said why
 * (app/api/cron/materialize-recurring/route.ts: "Without the company filter a
 * tombstoned workspace keeps minting brand-new LIVE transactions every night …
 * resurrecting 'deleted' data"). `sweepAutoCloseEntries` had no filter at all and
 * spent the whole window stamping `clockOutAt` and `autoClosed: true` into
 * deleted workspaces' timesheets. Two jobs, one rule, stated in one of them —
 * which is how the third job gets it wrong too. So it is stated here instead, and
 * `tests/lib/cron/live-scope.test.ts` fails if a job that writes to customer rows
 * stops using it.
 *
 * WHAT IS DELIBERATELY NOT IN HERE.
 *
 * `user: { deletedAt: null }` is not part of the rule, although cron-010's filing
 * suggested it. A whole-workspace deletion tombstones the User rows too
 * (`softDeleteWorkspace` in lib/actions/account.ts), so the company filter
 * already covers the case the rule exists for. What the user filter would add is
 * the INDIVIDUALLY deactivated person in a live workspace — and they cannot sign
 * in to stop their own running timer, so excluding them leaves an entry open for
 * ever. A permanently-running timer is worse data than an honest `autoClosed`
 * stamp at the person's last heartbeat, and nothing about them is pending a
 * restore. Per-model exceptions like that belong at the call site with a reason,
 * not in the shared rule.
 *
 * THE PURGE IS EXEMPT, and it is the one job that must be: it exists to erase
 * tombstoned workspaces, so the filter would make it a no-op. That exemption is
 * named in the test rather than left as an absence.
 *
 * Pure data, no I/O: safe to import anywhere, including from a route handler.
 */

/**
 * Prisma `where` fragment restricting a query to rows whose workspace is still
 * live. Spread it into the `where` of any background write.
 *
 * The model must have a `company` relation. Models scoped only by `companyId`
 * (with no relation field) are not reachable this way — filter on the parent
 * you do have, and say so where you do it.
 */
export const LIVE_WORKSPACE_SCOPE = { company: { deletedAt: null } } as const;

/**
 * The same, plus the row's own tombstone — for a model that is itself
 * soft-deletable. `TimeEntry`, `Transaction`, `Task`, `Comment`, `Budget`,
 * `Project` and `Message` all carry `deletedAt`, and a job that rewrites a
 * tombstoned row defeats the recovery the tombstone was written for.
 */
export const LIVE_ROW_AND_WORKSPACE_SCOPE = {
  deletedAt: null,
  company: { deletedAt: null },
} as const;
