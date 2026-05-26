# FounderFlow — silent-fail audit

Consolidated from three parallel sweeps (server actions + queries, client forms + state, infra + auth + cron). A "silent fail" here means: the program does the wrong thing, AND neither the user nor logs/alerts find out.

Format per row: severity, file, one-line bug, one-line fix. Tick boxes as we ship.

Counts: 7 HIGH, 11 MEDIUM, 8 LOW. Total 26.

---

## HIGH — data corruption, cross-tenant, or silent rejection of valid input

- [ ] **H1** — `lib/actions/transactions.ts` (deleteTransactionAction activity log)
  Transaction has a `projectId`; the deletion activity row is written without it, so project Activity tabs miss the deletion event entirely.
  **Fix:** add `projectId: txn.projectId` to the `tx.activity.create({ data: ... })` call inside the delete transaction.

- [ ] **H2** — `lib/actions/tasks.ts` (deleteTaskAction activity log)
  Same shape — Task always has `projectId` now (required since `add_projects`), but the delete activity row never copies it. Project Activity tab silently drops the row.
  **Fix:** add `projectId: task.projectId` to the activity write.

- [ ] **H3** — `auth.config.ts` (middleware redirect for members)
  When a member hits a finance route, we redirect to `homeRouteForRole(role)` but discard `request.nextUrl.search`. Any querystring state (e.g. `?ref=email-link`) is silently dropped.
  **Fix:** preserve search: `NextResponse.redirect(new URL(homeRouteForRole(role), request.nextUrl))` — and when forwarding, build the URL with `home + nextUrl.search` if a query existed.

- [ ] **H4** — `app/(app)/projects/[id]/edit-project-modal.tsx` (`defaultValues.targetEndDate`)
  The form seeds the field with a `Date` object, but the `<input type="date">` expects a `yyyy-mm-dd` string. The `setValueAs` we added handles changes but not the initial render — the displayed value drifts from RHF state. Subtle but the *next* RHF re-validation can erase the user's value.
  **Fix:** seed with `toLocalDateInput(project.targetEndDate)` (already imported), not `new Date(...)`. Drop the now-redundant `defaultValue` HTML attr.

- [ ] **H5** — `components/layout/sidebar.tsx` (currentUser hydration window)
  `currentUser?.role` falls back to `"member"` when Zustand persist is still hydrating from localStorage. For ~50ms after page load an admin sees the member sidebar (no Dashboard / Expenses / etc.). With a slow disk it's longer.
  **Fix:** add an `isHydrated` flag to the Zustand store (set in the `onRehydrateStorage` callback) and gate the sidebar nav filter on it. While hydrating, show all admin items (the middleware still enforces).

- [ ] **H6** — `lib/auth.ts` `authorize()` (fire-and-forget lastSignInAt)
  The `lastSignInAt` update is `.catch(() => {})`. If the DB write fails (connection blip, schema drift), the audit timestamp silently rots and no Sentry issue ever fires.
  **Fix:** `.catch((e) => captureServerError(e, { action: "updateLastSignInAt", extra: { userId: user.id } }))`.

- [ ] **H7** — `router.refresh()` not wrapped in `startTransition` (5 call sites)
  `components/time/clock-widget.tsx:140`, `:177`, `:195`; `app/(app)/tasks/tasks-client.tsx:130`; `app/(app)/expenses/expenses-client.tsx:69`. React shows the old RSC while the refresh is in-flight; in the time-tracker case the user sees a still-running pill for several hundred ms after they clocked out, leading to double-click and a redundant clockOut error.
  **Fix:** wrap each: `startTransition(() => router.refresh());`. Import `useTransition` once where it's missing.

---

## MEDIUM — side effects drop, success returned when nothing happened

- [ ] **M1** — `lib/actions/budgets.ts` `updateBudgetAction`
  If neither `monthlyLimit` nor `active` is provided, the action returns `{ success: true }` without touching the DB. Frontend thinks it saved.
  **Fix:** reject empty patches: `if (data === {}) return { success: false, error: "Nothing to update" };` Make `UpdateBudgetSchema` require at least one optional field at parse time.

- [ ] **M2** — `lib/actions/notifications.ts` `markAllNotificationsReadAction`
  `updateMany({ ... read: false }, { read: true })` returns `{ count }` but we ignore it. If the user has no unread notifications, we still revalidate `/notifications` and toast success.
  **Fix:** check `count > 0`; only revalidate + return success when work happened, else return `{ success: true, data: { changed: 0 } }` so the UI can skip the optimistic mark.

- [ ] **M3** — `lib/actions/notifications.ts` `clearNotificationsAction`
  Same shape — `deleteMany` returns `count`, we discard it.
  **Fix:** same pattern as M2.

- [ ] **M4** — `lib/email/send.ts` (SMTP error path)
  Send failures are logged with `console.error` but never sent to Sentry. The invite stays in the DB; the recipient never gets the email; admin has no signal.
  **Fix:** `captureServerError(e, { action: "sendEmail", extra: { to, subject } })` on the catch path, and return `{ delivered: false, reason: e.message }` so callers can decide whether to retry.

- [ ] **M5** — `lib/actions/team.ts` (inviteUserAction email failure)
  When email send returns `{ delivered: false }` (M4 fix supplied), the action proceeds happily — invite row exists, no notification fired, admin sees a green toast.
  **Fix:** if `!sendResult.delivered`, mark the InviteToken with an `emailFailedAt` column (new optional field) and surface in the UI: "Invite created, email failed — copy link manually."

- [ ] **M6** — `lib/auth.ts` `authorize()` (failed password silent)
  Wrong password returns `null` — Auth.js handles it, the rate limiter handles it, but no Sentry event distinguishes "5 typos from a real user" from "5 brute-force tries from a script."
  **Fix:** `captureServerError(new Error("Credentials rejected"), { action: "authorize", extra: { email, hashPrefix: user.passwordHash.slice(0, 7) } })` only on the post-user-lookup mismatch (not on "user not found", which is normal).

- [ ] **M7** — `components/layout/topbar.tsx` `handleLogout` (logoutAction result discarded)
  `await logoutAction();` — no result check. If signOut throws on the server, we clear local Zustand but the cookie persists. User looks logged out but a reload puts them back in.
  **Fix:** wrap in try/catch and surface a toast on failure; only clear local state on success.

- [ ] **M8** — `app/(app)/settings/settings-client.tsx` `handleLogout`
  Same bug as M7.
  **Fix:** same fix.

- [ ] **M9** — `app/(app)/team/team-client.tsx` (role change refresh missing)
  Role updates land on the server; the client never calls `router.refresh()`, so the UI keeps the old role visible until a manual nav.
  **Fix:** call `startTransition(() => router.refresh())` in the success branch.

- [ ] **M10** — `app/api/cron/sweep-time-entries/route.ts` (error context missing)
  The cron catches and re-throws as a generic 500; no per-entry diagnostics in Sentry. When the auto-close pipeline drops work, you can't see which user's session got abandoned.
  **Fix:** change `sweepAutoCloseEntries()` to return `{ closed: string[], failed: { id, error }[] }`. Log each `failed` to Sentry with the entry id + companyId; respond `206` if there are failures.

- [ ] **M11** — `app/api/cron/materialize-recurring/route.ts` (Sentry capture context)
  Per-rule catch logs to Sentry with only `ruleId`. Missing `companyId` and the partial-success counts.
  **Fix:** `captureServerError(e, { action: "materializeRecurring", extra: { ruleId, companyId, succeededSoFar: created.length } })`.

---

## LOW — cosmetic, monitoring gap, or recoverable

- [ ] **L1** — `components/time/clock-widget.tsx` (visibility-aware ticker)
  When the tab becomes visible again after being hidden, the 1s ticker doesn't immediately re-sync — there's a 60s lag before the running pill updates. Minor.
  **Fix:** in the `visibilitychange` handler already present, call `setNow(new Date())` once on focus, then let the interval take over.

- [ ] **L2** — `components/comments/comment-thread.tsx` `refresh()`
  The wrapper doesn't await `onChanged?.()` before re-fetching, so a parent `router.refresh()` can race with the local `setComments` update — comment appears briefly, vanishes, reappears.
  **Fix:** make `onChanged` return the promise (it's `() => void` today) and `await` it in `refresh()`.

- [ ] **L3** — `components/layout/sidebar.tsx` (interval cleanup race)
  The 30s `listNotificationsAction` poller's cleanup sets `cancelled = true` but doesn't bail out of an in-flight fetch — if unmount happens mid-fetch, the resolved promise still calls `setUnreadCount`, causing a "set state on unmounted component" warning.
  **Fix:** check `cancelled` at the start of the `if (res.success)` branch too.

- [ ] **L4** — `lib/rate-limit.ts` (in-memory bucket recycle)
  Vercel's serverless instance recycle wipes the bucket — first minute after a cold start has no rate limiting. Acceptable for now but undocumented.
  **Fix:** add a code comment + Sentry breadcrumb on bucket init so we can see the recycle frequency.

- [ ] **L5** — `lib/sentry-server.ts` (auto-context)
  `captureServerError` requires every call site to manually pass `userId` / `companyId` in `extra`. Most don't, so Sentry issues come in untagged.
  **Fix:** add optional `userId` + `companyId` params that auto-populate Sentry tags + user context.

- [ ] **L6** — `next.config.js` (Sentry config completeness)
  `sentryEnabled` checks `SENTRY_DSN` + `SENTRY_AUTH_TOKEN` but not `SENTRY_ORG` / `SENTRY_PROJECT`. With one set and the others missing, source map upload silently no-ops at build time.
  **Fix:** throw at build-time if Sentry is partially configured.

- [ ] **L7** — `app/api/cron/materialize-recurring/route.ts` (partial-failure HTTP status)
  Returns HTTP 200 even when some rules failed. Vercel cron monitoring only alerts on 5xx — partial failures go unnoticed.
  **Fix:** return `206 Partial Content` if `failed.length > 0`. Add a Sentry warning-level message too.

- [ ] **L8** — `lib/actions/comments.ts` `createCommentAction` (notification fan-out)
  Already correctly logged via `captureServerError`, BUT the action returns `{ success: true, data: { mentionedUserIds } }` even when the fan-out failed. UI says "pinged 3 teammates" — they got nothing.
  **Fix:** track the actual fan-out result count and return `{ ..., notifiedCount }`; have the toast say "pinged N teammates" with the real number.

---

## Suggested fix order

If we knock these out in this order, each batch is a self-contained PR:

1. **H1 + H2 + H7** — the project-activity gaps + the `router.refresh()` wrap. Small, mechanical. ~30 min.
2. **H3 + H5** — middleware redirect with query string + sidebar hydration flag. ~1 hr.
3. **H4** — edit-project-modal defaultValue fix. 10 min.
4. **H6 + M6** — auth.ts captureServerError on the two silent paths. 20 min.
5. **M1 + M2 + M3** — return-success-on-no-op fixes in budgets + notifications. 30 min.
6. **M4 + M5** — email send error surfacing + InviteToken.emailFailedAt column (needs a small migration). 1 hr.
7. **M7 + M8** — logout result checks. 15 min.
8. **M9** — team role-change refresh. 5 min.
9. **M10 + M11** — cron context + partial-failure status. 30 min.
10. **L1–L8** — polish batch. ~2 hrs together.

Total ~6 hours of fix work. We can stagger or take in one sitting; I'd start with batch 1 since it touches the same project surface we just shipped.
