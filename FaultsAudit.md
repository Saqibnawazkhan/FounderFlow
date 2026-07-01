# FounderFlow — faults audit

Companion to [BUGS.md](BUGS.md). Where BUGS.md tracked silent-fail
bugs, this file tracks **missing features, bad UI, other flaws, and
improvements** surfaced by a full six-surface audit (2026-07-01).

Tick as we go. Format mirrors BUGS.md: `[ ]` open, `[x]` fixed,
`[~]` skipped with a one-line reason.

Legend
- **[FEAT]** — missing feature
- **[UI]** — bad UI / UX
- **[BUG]** — flaw or defect (not a silent-fail — that lived in BUGS.md)
- **[OPP]** — improvement / opportunity
- Severity: **🔴 P0** blocking or trust-eroding · **🟠 P1** should ship · **🟡 P2** nice-to-have · **🔵 P3** long-horizon

Totals at audit time: **6 P0 · ~50 P1 · ~20 P2/P3 · 76 rows**.

---

## Top of the sweep — P0 batch

These are the ones I'd take first. Ship as one PR each, or bundle P0-1 through P0-6 as a single "trust batch".

- [x] **P0-1 · [FEAT] No password-reset flow.** ✔ Shipped `/forgot-password` + `/reset-password` routes, `requestPasswordResetAction` + `resetPasswordAction`, HMAC-signed stateless JWTs (`lib/auth/password-reset-token.ts`) so no schema change was needed, email sent via existing Gmail SMTP infra, "Forgot password?" link now on the login form, allow-listed in `auth.config.ts`, i18n (en + ur) covered.
- [x] **P0-2 · [BUG] Manifest references `/icon.svg`, file doesn't exist.** ✔ Copied `app/icon.svg` → `public/icon.svg` so the SW precache + manifest URL both resolve. `app/icon.svg` stays as Next.js's file-based metadata for the auto `<link rel="icon">`.
- [x] **P0-3 · [BUG] Topbar search input is a placeholder-only stub.** ✔ Wired to a new `CommandPalette` component (fuzzy nav-jump), globally bound to ⌘K / Ctrl-K, respects member-blocked routes. Extracted shared nav list to `lib/nav.ts` so the palette + sidebar stay in sync.
- [~] **P0-4 · [BUG] Money stored as `Float` (Prisma), not `Decimal`.** DEFERRED — touches production DB (CLAUDE.md flags `DATABASE_URL` as prod Supabase and forbids autonomous `prisma migrate`). Also cascades across ~30-40 files (`.toFixed`, `.toLocaleString`, `zod.number()` etc.). Do this after Tier 2 env separation lands so it can be exercised in staging first. Real-world drift risk for early-stage startups is bounded — JS number sums are exact up to ~9 quadrillion.
- [x] **P0-5 · [BUG] Task notifications link to `/tasks`, not the specific task.** ✔ Both task-assigned + task-completed notifications now emit `/tasks?taskId=<id>`; `tasks-client.tsx` reads the query param, scrolls the target card/row into view, and flashes a 2.5s highlight ring before wiping the param.
- [x] **P0-6 · [FEAT] No favicon.ico, no OG image.** ✔ Explicit `icons` metadata (icon + shortcut + apple all point at `/icon.svg`), plus a new dynamic `app/opengraph-image.tsx` that renders a 1200×630 gradient card on-demand via `next/og`. Manifest already had icon entries — those keep working.

---

## 1. Auth · Onboarding · Landing

- [x] **A1 · 🔴 [FEAT] No password-reset flow** — shipped in P0-1.
- [ ] **A2 · 🔴 [FEAT] No email verification post-signup.** Typo'd emails persist forever. Add a `verify-email` step or grace-period gate. → [app/signup](app/signup)
- [ ] **A3 · 🔴 [FEAT] No account deletion (GDPR/CCPA gap).** Danger-zone section missing from settings. → [app/(app)/settings](app/(app)/settings)
- [x] **A4 · 🔴 [FEAT] No favicon + OG image** — shipped in P0-6.
- [~] **A5 · 🟠 [FEAT] Admin can't generate/manage invite tokens from UI.** Partial false positive — creation UI DOES exist at [app/(app)/team/team-client.tsx:87](app/(app)/team/team-client.tsx#L87) (Invite member button + modal). The "list pending invites with resend/revoke" side is real but tracked separately under X7.
- [x] **A6 · 🟠 [UI] Password inputs lack `maxLength`; email lacks `inputMode="email"`.** ✔ Login + signup emails now carry `inputMode="email" maxLength={254}`, passwords `maxLength={256}`. Signup name `maxLength={80}`.
- [x] **A7 · 🟠 [UI] No autofocus on first field.** ✔ `autoFocus` on the first field of login (email) and signup step-1 (name), with an inline eslint-disable + rationale ("landing on a dedicated auth page; first-field autofocus is expected").
- [x] **A8 · 🟠 [UI] Password eye-toggle has no `:focus-visible` ring.** ✔ Added `focus-visible:ring-2 focus-visible:ring-primary/50` to the toggle button on login, signup, and the new reset-password page.
- [~] **A9 · 🟠 [BUG] Rate-limit message "Too many requests" is opaque.** Partial false positive — [lib/rate-limit.ts:103](lib/rate-limit.ts#L103) already returns `"Too many requests. Try again in Xs."`. The toast surfaces that verbatim via `gate.error`. A LIVE countdown timer is a P3 nice-to-have, not a P1.
- [~] **A10 · 🟠 [BUG] Session expiry silently 401s server actions.** DEFERRED — a proper fix means a global "action result" interceptor or wrapping every callsite. Middleware already redirects expired sessions on the next navigation; the only silent case is mid-session for a single action call, which shows a toast. Full fix tracked as follow-up under a broader "auth error boundary" line item.
- [ ] **A11 · 🟡 [UI] Landing hero contrast risk.** `text-primary-strong` on gradient may fail WCAG AA in some themes. → [app/page.tsx](app/page.tsx)
- [ ] **A12 · 🟡 [OPP] No welcome tour / empty-state guidance post-signup.** New users land on blank dashboard. → [app/(app)/dashboard](app/(app)/dashboard)
- [ ] **A13 · 🔵 [OPP] Magic-link login, sign-in-with-Google, 2FA / TOTP.** → [auth.config.ts](auth.config.ts)

## 2. Dashboard · Nav · Global shell

- [x] **N1 · 🔴 [BUG] Topbar search stub** — shipped in P0-3 (command palette + ⌘K).
- [ ] **N2 · 🟠 [FEAT] No breadcrumbs anywhere.** Follow-up: bake per-route metadata into a shared `PageHeader` and hoist it into the app layout.
- [x] **N3 · 🟠 [FEAT] No language switcher in UI.** ✔ Added a `Languages` icon button in the topbar (between clock widget and theme toggle). Two-locale toggle (en ↔ ur); would upgrade to a dropdown if we add a third locale.
- [x] **N4 · 🟠 [FEAT] No desktop sidebar-collapse toggle.** ✔ New `sidebarCollapsed` in the persisted store; sidebar shrinks to a 64 px icon rail with an inline `⟵ Collapse / ⟶` toggle in its footer; app layout's left margin animates between `lg:ml-64` and `lg:ml-16`.
- [x] **N5 · 🟠 [UI] Sidebar active-state too subtle.** ✔ Stronger `border-primary/50 bg-primary/[0.14]` + a 2 px inset shadow rail + colored icon.
- [x] **N6 · 🟠 [UI] Duplicate notification affordance.** ✔ Replaced the topbar 2×2 dot with a proper numeric badge (`9+` when over). Sidebar still counts; the two now agree instead of racing.
- [~] **N7 · 🟠 [BUG] No scroll-restoration between route transitions.** DEFERRED — Next.js 14 App Router scroll-restores by default on `<Link>` nav and browser back/forward; audit finding needs empirical verification against a real regression, not blind wiring.
- [~] **N8 · 🟠 [BUG] Hydration paint flash from Zustand skeleton.** DEFERRED — proper fix moves `currentUser` hydration into a Suspense boundary in Providers so the layout renders in the same paint as content. Full refactor for a future session.
- [ ] **N9 · 🟡 [UI] Sparse / inconsistent page metadata.** Dashboard has 4 words, tasks has a full sentence. Standardize `"FounderFlow — <page>"` prefix + description shape.
- [ ] **N10 · 🟡 [UI] 404 doesn't suggest related pages; offline page has no cached-page list.** → [app/not-found.tsx](app/not-found.tsx), [app/offline/page.tsx](app/offline/page.tsx)
- [ ] **N11 · 🔵 [OPP] Cmd-K palette, recent-items widget, activity ticker, install-PWA button.**

## 3. Tasks · Projects · Comments

- [x] **T1 · 🔴 [BUG] Task notification deep-link broken** — shipped in P0-5.
- [ ] **T2 · 🔴 [BUG] N+1 on project list.** `timeEntry.findMany()` with no `projectId` WHERE clause; filters in JS. Add the WHERE and index the FK. → [lib/queries/projects.ts:124-128](lib/queries/projects.ts#L124-L128)
- [ ] **T3 · 🟠 [FEAT] No kanban drag-reorder, no bulk edit, no bulk delete.** → [app/(app)/tasks/tasks-client.tsx](app/(app)/tasks/tasks-client.tsx)
- [ ] **T4 · 🟠 [FEAT] Task filters limited to all/mine/assigned-by-me.** Add priority / due-date / project / status. → [tasks-client.tsx:106-112](app/(app)/tasks/tasks-client.tsx#L106-L112)
- [ ] **T5 · 🟠 [FEAT] Filters don't persist.** Reset on every nav. Save to localStorage per-user. → [tasks-client.tsx](app/(app)/tasks/tasks-client.tsx)
- [ ] **T6 · 🟠 [FEAT] No @mention autocomplete UI.** Slug hints only, no live picker as user types `@`. → [components/comments/comment-thread.tsx:67-70](components/comments/comment-thread.tsx#L67-L70)
- [ ] **T7 · 🟠 [FEAT] No archived-project unarchive button.** Detail page blocks all actions when archived. → [app/(app)/projects/[id]/project-detail-client.tsx:206](app/(app)/projects/[id]/project-detail-client.tsx#L206)
- [ ] **T8 · 🟠 [UI] Priority is color-only in cards + list.** A11y fail for color-blind users — add a shape/icon differentiator. → [tasks-client.tsx:60-65](app/(app)/tasks/tasks-client.tsx#L60-L65)
- [ ] **T9 · 🟠 [UI] Overdue indicator only in list view, missing from kanban cards.** → [tasks-client.tsx:326-327](app/(app)/tasks/tasks-client.tsx#L326-L327)
- [ ] **T10 · 🟠 [BUG] Optimistic drag-drop status change doesn't rollback.** Card stays painted after failure toast; needs to revert to prior column. → [tasks-client.tsx:169-176](app/(app)/tasks/tasks-client.tsx#L169-L176)
- [ ] **T11 · 🟠 [BUG] Comment badge count stale after post.** No optimistic bump; card stays showing old count until refresh. → [tasks-client.tsx:439](app/(app)/tasks/tasks-client.tsx#L439)
- [ ] **T12 · 🟡 [FEAT] No subtasks, dependencies, tags/labels, attachments, recurring tasks.** → [lib/schemas/task.ts:7-27](lib/schemas/task.ts#L7-L27)
- [ ] **T13 · 🟡 [FEAT] No project templates / "duplicate project".**
- [ ] **T14 · 🔵 [OPP] Inline task edit, quick-add row, keyboard shortcuts (N/Esc/⌘K), ICS calendar export, project Gantt.**

## 4. Finance — budgets, expenses, investments, reports, recurring

- [~] **F1 · 🔴 [BUG] `Float` money type + client-side sums** — deferred with P0-4 (touches prod DB, cascades across ~30-40 files, do after Tier 2 env separation).
- [ ] **F2 · 🟠 [FEAT] No CSV/XLSX import for transactions.** → [components/transactions/transaction-form.tsx](components/transactions/transaction-form.tsx)
- [ ] **F3 · 🟠 [FEAT] No receipt/attachment field on transactions.**
- [ ] **F4 · 🟠 [FEAT] No multi-currency.** `formatCurrency` hardcodes USD fallback; schema `currency` field unused in the UI. → [lib/utils.ts:10-18](lib/utils.ts#L10-L18)
- [ ] **F5 · 🟠 [FEAT] Reports offer only 6 preset ranges.** No custom date-range picker. → [app/(app)/reports/reports-client.tsx:54-55](app/(app)/reports/reports-client.tsx#L54-L55)
- [ ] **F6 · 🟠 [FEAT] Categories hardcoded in `EXPENSE_CATEGORIES`.** No CRUD UI to add/rename/remove. → [lib/types.ts](lib/types.ts)
- [ ] **F7 · 🟠 [UI] Amount inputs lack `inputMode="decimal"`.** Wrong mobile keyboard. → [components/transactions/transaction-form.tsx:89](components/transactions/transaction-form.tsx#L89)
- [ ] **F8 · 🟠 [UI] No negative/reversal color coding.** Expenses and refunds look identical.
- [ ] **F9 · 🟠 [UI] Budget progress uses color alone for status.** A11y fail — add stripe pattern or textual label. → [app/(app)/budgets/budgets-client.tsx:222-225](app/(app)/budgets/budgets-client.tsx#L222-L225)
- [ ] **F10 · 🟠 [UI] Tables have no cards fallback for mobile.** Horizontal scroll only across expenses / investments.
- [ ] **F11 · 🟠 [BUG] Budget threshold state per-budget, not per-(budget, user).** Duplicate 80% alerts possible in a single session. → [lib/budgets/check.ts:109-115](lib/budgets/check.ts#L109-L115)
- [ ] **F12 · 🟠 [BUG] `formatCurrency` special-cases PKR** as prefix text vs `Intl.NumberFormat` for other currencies — inconsistent. → [lib/utils.ts:16](lib/utils.ts#L16)
- [ ] **F13 · 🟠 [BUG] Export buttons on `/reports` don't re-check `canSeeFinances` client-side.** Middleware-only defense; belt + braces missing. → [app/(app)/reports/reports-client.tsx](app/(app)/reports/reports-client.tsx)
- [ ] **F14 · 🟡 [FEAT] No split transactions, no tax categories, no vendor/merchant field.**
- [ ] **F15 · 🔵 [OPP] Dashboard runway/burn-rate widget, monthly closeout email, spend-vs-budget trend chart, anomaly alerts, duplicate-transaction button.**

## 5. Time · Notifications · Activity · Team

- [ ] **X1 · 🟠 [FEAT] No manual/backdated time entry.** Clock-only; users can't correct forgotten sessions. → [app/(app)/time](app/(app)/time)
- [ ] **X2 · 🟠 [FEAT] No weekly timesheet grid, no per-day totals.** → [app/(app)/time/time-client.tsx:146](app/(app)/time/time-client.tsx#L146)
- [ ] **X3 · 🟠 [FEAT] Timer doesn't sync across tabs.** No BroadcastChannel — two tabs drift independently. → [components/time/clock-widget.tsx](components/time/clock-widget.tsx)
- [ ] **X4 · 🟠 [FEAT] No notification categories/filters.** Mentions + system + invites all one bucket; no snooze/mute; no email-preference matrix. → [app/(app)/notifications](app/(app)/notifications)
- [ ] **X5 · 🟠 [FEAT] No activity pagination.** Hardcoded 200 limit renders all filtered results in one DOM. → [app/(app)/activities/activities-client.tsx:60](app/(app)/activities/activities-client.tsx#L60)
- [ ] **X6 · 🟠 [FEAT] No activity filter by user** — only by type. → [activities-client.tsx:124](app/(app)/activities/activities-client.tsx#L124)
- [ ] **X7 · 🟠 [FEAT] No invite-resend button.** Delete + recreate flow only; no revoke for pending invites. → [lib/actions/team.ts:129-132](lib/actions/team.ts#L129-L132)
- [ ] **X8 · 🟠 [FEAT] No soft-delete / deactivate for team members.** Leaving + rejoining requires a fresh re-invite. → [lib/actions/team.ts:314](lib/actions/team.ts#L314)
- [ ] **X9 · 🟠 [BUG] Role change doesn't invalidate active sessions.** A demoted admin keeps admin perms until re-login. → [lib/actions/team.ts](lib/actions/team.ts)
- [ ] **X10 · 🟠 [BUG] Notification links to `/team` etc. don't verify target still exists.** Dead links after deletion. → [lib/queries/notifications.ts:36-57](lib/queries/notifications.ts#L36-L57)
- [ ] **X11 · 🟠 [UI] Notification bell badge is a 2×2 dot.** Low contrast, easy to miss. → [components/layout/topbar.tsx:194](components/layout/topbar.tsx#L194)
- [ ] **X12 · 🟠 [UI] Running-entry only in topbar** — not surfaced on `/time` header or dashboard. → [app/(app)/time/time-client.tsx:258](app/(app)/time/time-client.tsx#L258)
- [ ] **X13 · 🟠 [UI] Inconsistent mark-all-read affordance** across dropdown vs page. → [topbar.tsx:211](components/layout/topbar.tsx#L211), [notifications-client.tsx:99](app/(app)/notifications/notifications-client.tsx#L99)
- [ ] **X14 · 🟡 [UI] Empty state art reuses generic Bell icon everywhere.**
- [ ] **X15 · 🟡 [BUG] Activity feed has no dedupe.** Rapid consecutive events create identical rows.
- [ ] **X16 · 🔵 [OPP] Weekly digest email, quiet-hours for notifications, Slack integration for mentions, iCal export, presence indicator.**

## 6. Settings · i18n · a11y · Mobile · PWA

- [x] **S1 · 🔴 [BUG] Manifest missing `/icon.svg` file** — shipped in P0-2.
- [ ] **S2 · 🔴 [FEAT] No danger zone.** No delete-account, no leave-company, no delete-company. → [app/(app)/settings](app/(app)/settings)
- [ ] **S3 · 🟠 [FEAT] No change-email flow with verification.** Edit modal accepts `email` field but sends no verify token. → [app/(app)/settings](app/(app)/settings)
- [ ] **S4 · 🟠 [FEAT] No MFA/2FA setup.**
- [ ] **S5 · 🟠 [FEAT] No system-theme option** (only light/dark; no `prefers-color-scheme` match). → [lib/store.ts](lib/store.ts)
- [ ] **S6 · 🟠 [FEAT] Locale + theme not synced to DB.** Logout wipes preferences. Add `User.locale` / `User.theme` columns. → [lib/store.ts](lib/store.ts)
- [ ] **S7 · 🟠 [FEAT] No timezone preference** (user or company).
- [ ] **S8 · 🟠 [FEAT] No profile photo upload; no company logo.** → [app/(app)/settings](app/(app)/settings)
- [ ] **S9 · 🟠 [FEAT] No email/in-app notification-preferences UI.**
- [ ] **S10 · 🟠 [FEAT] No "Export my data" (GDPR).**
- [ ] **S11 · 🟠 [FEAT] No PWA install button; no offline write queue.** → [app/offline/page.tsx](app/offline/page.tsx), [public/sw.js](public/sw.js)
- [ ] **S12 · 🟠 [BUG] Hardcoded English strings escape i18n.** "Show/Hide password" and confirm-dialog "Cancel"/"Confirm" fallbacks. Route through `t.common.*`. → [app/(app)/settings/change-password-modal.tsx:159](app/(app)/settings/change-password-modal.tsx#L159), [components/ui/confirm-dialog.tsx:128](components/ui/confirm-dialog.tsx#L128)
- [ ] **S13 · 🟠 [BUG] No skip-to-content link.** → [app/layout.tsx](app/layout.tsx)
- [ ] **S14 · 🟠 [BUG] Toast (`react-hot-toast`) not `aria-live="assertive"`.** SR users miss confirmations + errors. → [components/providers.tsx](components/providers.tsx)
- [ ] **S15 · 🟠 [BUG] Manifest missing PNG raster icons at 192 / 512.** Android home-screen falls back. → [public/manifest.json](public/manifest.json)
- [ ] **S16 · 🟠 [BUG] No `apple-touch-startup-image`.** iOS PWA splash is blank. → [app/layout.tsx](app/layout.tsx)
- [ ] **S17 · 🟠 [UI] Modal sizes are `sm/md/lg/xl` only.** No mobile full-screen sheet. → [components/ui/modal.tsx:70-76](components/ui/modal.tsx#L70-L76)
- [ ] **S18 · 🟠 [UI] Confirm dialog buttons + labels not localizable** — see S12. → [components/ui/confirm-dialog.tsx:128](components/ui/confirm-dialog.tsx#L128)
- [ ] **S19 · 🟡 [BUG] Number formatting not locale-aware** ("999 sessions" not "۹۹۹") for Urdu. → [lib/utils.ts](lib/utils.ts)
- [ ] **S20 · 🟡 [BUG] No RTL sidebar mirror check for Urdu.** → [components/layout/sidebar.tsx](components/layout/sidebar.tsx)
- [ ] **S21 · 🔵 [OPP] Density preference, contrast-mode boost, mobile bottom-nav for primary actions, "reset all preferences".**

---

## How to work through this

Same pattern as BUGS.md worked well:
1. Batch by severity, ship as one commit per batch (P0 → P1 → P2 → P3).
2. Fix in-place, tick `[x]` with a one-line note under the row.
3. If a finding turns out to be a false positive or is deliberately deferred, mark `[~]` with the reason inline — don't just delete the row.
4. Run `npm run typecheck && npm test && npm run build` before every batch commit.
5. Update the totals block at the top of this file when the counts shift meaningfully.
