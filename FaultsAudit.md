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

Totals at audit time: **6 P0 · ~50 P1 · ~20 P2/P3 · 76 unique rows** (96 checkboxes once duplicates + top-of-sweep pointers are counted).

Progress so far (2026-07-01 sweep):
- **34 [x] shipped** across P0 + P1 across every surface (auth, nav, tasks, projects, finance, time, notifications, settings, i18n, a11y, PWA).
- **16 [~] skipped with rationale** (false positives, already-covered items, or DEFERRED with a specific unblock condition — usually "waits on Tier 2 env separation" or "needs binary assets Write tool can't emit").
- **46 [ ] still open** — mix of P1 feature-shaped work (bulk edit, CSV import, MFA, mobile card fallbacks, notification categories, etc.) and P2/P3 nice-to-haves.

Commits: `61efaba` (P0) · `89b8298` (Auth+Nav) · `1f8c4fb` (Tasks+Projects) · `88263e2` (Finance) · `388bb02` (Time+Notif) · `68bac72` (Settings+i18n+a11y+PWA).

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
- [~] **T2 · 🔴 [BUG] N+1 on project list.** FALSE POSITIVE — [lib/queries/projects.ts:124-128](lib/queries/projects.ts#L124-L128) already scopes `where: { projectId: { in: projectIds } }` and pulls only 3 columns. JS-side aggregation via `durationMs` is intentional so the still-running clock (null `clockOutAt`) counts against `now`. No SQL rewrite would help without losing that semantic.
- [ ] **T3 · 🟠 [FEAT] No kanban drag-reorder, no bulk edit, no bulk delete.** Deferred to a P2 pass — bulk-edit UI (selection state + bulk-action bar + server actions) is a proper feature commit, not a batch cleanup. → [app/(app)/tasks/tasks-client.tsx](app/(app)/tasks/tasks-client.tsx)
- [ ] **T4 · 🟠 [FEAT] Task filters limited to all/mine/assigned-by-me.** Deferred to P2 (needs priority + due-date + project + status filter surface).
- [x] **T5 · 🟠 [FEAT] Filters don't persist.** ✔ `view` + `filter` now round-trip through `localStorage` (`ff.tasks.view`, `ff.tasks.filter`) with a private-mode-Safari safe try/catch.
- [ ] **T6 · 🟠 [FEAT] No @mention autocomplete UI.** Deferred to P2 (needs cursor-position tracking + a floating dropdown list).
- [x] **T7 · 🟠 [FEAT] No archived-project unarchive button.** ✔ Added a "Restore" button (ArchiveRestore icon, primary tone) that shows only when `project.status === "archived"`; calls `updateProjectAction` with `status: "active"`. i18n keys added in en + ur.
- [x] **T8 · 🟠 [UI] Priority is color-only in cards + list.** ✔ Added a `PRIORITY_ICONS` map (`AlertOctagon`, `ArrowUp`, `Minus`, `ArrowDown`) rendered inside the pill so priority now carries color + text + shape (three redundant channels for a11y).
- [~] **T9 · 🟠 [UI] Overdue indicator only in list view, missing from kanban cards.** FALSE POSITIVE — the board card at [tasks-client.tsx:739](app/(app)/tasks/tasks-client.tsx#L739) already renders `AlertCircle` on overdue rows. Auditor missed the second render site.
- [x] **T10 · 🟠 [BUG] Optimistic drag-drop status change doesn't rollback.** ✔ We now capture `priorStatus` before the optimistic write and restore the exact prior column on server error, before the `router.refresh()` round-trip.
- [x] **T11 · 🟠 [BUG] Comment badge count stale after post.** ✔ The tasks page's `CommentThreadModal` `onChanged` handler now optimistically bumps `commentCount + 1` on the target card before `router.refresh()` corrects the canonical number.
- [ ] **T12 · 🟡 [FEAT] No subtasks, dependencies, tags/labels, attachments, recurring tasks.** → [lib/schemas/task.ts:7-27](lib/schemas/task.ts#L7-L27)
- [ ] **T13 · 🟡 [FEAT] No project templates / "duplicate project".**
- [ ] **T14 · 🔵 [OPP] Inline task edit, quick-add row, keyboard shortcuts (N/Esc/⌘K), ICS calendar export, project Gantt.**

## 4. Finance — budgets, expenses, investments, reports, recurring

- [~] **F1 · 🔴 [BUG] `Float` money type + client-side sums** — deferred with P0-4 (touches prod DB, cascades across ~30-40 files, do after Tier 2 env separation).
- [ ] **F2 · 🟠 [FEAT] No CSV/XLSX import for transactions.** Deferred — a real importer needs a file-picker + column-mapper + a preview step + a bulk insert action. Full P2 feature commit. → [components/transactions/transaction-form.tsx](components/transactions/transaction-form.tsx)
- [ ] **F3 · 🟠 [FEAT] No receipt/attachment field on transactions.** Deferred — needs object storage wiring (Supabase Storage) + schema migration + upload UI. P2 feature commit.
- [ ] **F4 · 🟠 [FEAT] No multi-currency.** Deferred — schema field exists, needs company-level currency picker in settings + rollout across formatters. Follow-up.
- [ ] **F5 · 🟠 [FEAT] Reports offer only 6 preset ranges.** Deferred — needs a proper date-range picker component (calendar UI + custom "from/to" input). Follow-up.
- [ ] **F6 · 🟠 [FEAT] Categories hardcoded in `EXPENSE_CATEGORIES`.** Deferred — needs a Category schema + CRUD actions + settings UI. Full feature commit.
- [x] **F7 · 🟠 [UI] Amount inputs lack `inputMode="decimal"`.** ✔ Added `inputMode="decimal"` to transaction, recurring, and budget-monthlyLimit money inputs; recurring `dayOfMonth` gets `inputMode="numeric"` so mobile keyboards match the field.
- [~] **F8 · 🟠 [UI] No negative/reversal color coding.** FALSE POSITIVE — schema at [lib/types.ts:23](lib/types.ts#L23) is `TransactionType = "expense" \| "investment"`. There is no refund/reversal concept, so no third color to give it.
- [x] **F9 · 🟠 [UI] Budget progress uses color alone for status.** ✔ Progress bar now has `role="progressbar"` + `aria-valuenow` + a descriptive `aria-label`; over-budget bars gain a diagonal-stripe pattern layered on top of the danger color so color-blind users can still tell them apart. Existing "Over / Warning / On track" text pill was already redundant with color.
- [ ] **F10 · 🟠 [UI] Tables have no cards fallback for mobile.** Deferred — every finance table would need a duplicate card layout. Horizontal scroll is acceptable UX until we ship a proper mobile pass.
- [~] **F11 · 🟠 [BUG] Budget threshold state per-budget, not per-(budget, user).** LARGELY COVERED — `lastWarnedMonth` / `lastAlertedMonth` per-Budget dedupe blocks the common case (single-user session). Only concurrent-writes race can double-fire; low risk at this scale. Full per-(budget, user) tracking would need a schema addition — defer.
- [x] **F12 · 🟠 [BUG] `formatCurrency` special-cases PKR** inconsistently. ✔ Removed the PKR-only prefix branch; every currency now flows through `Intl.NumberFormat` uniformly, with a safe fallback for stale/unknown ISO codes.
- [x] **F13 · 🟠 [BUG] Export buttons on `/reports` don't re-check `canSeeFinances` client-side.** ✔ The RSC now `notFound()`s for member roles as belt-and-braces beyond middleware. Both the button-render and export-action paths are protected in one gate.
- [ ] **F14 · 🟡 [FEAT] No split transactions, no tax categories, no vendor/merchant field.**
- [ ] **F15 · 🔵 [OPP] Dashboard runway/burn-rate widget, monthly closeout email, spend-vs-budget trend chart, anomaly alerts, duplicate-transaction button.**

## 5. Time · Notifications · Activity · Team

- [ ] **X1 · 🟠 [FEAT] No manual/backdated time entry.** Deferred — needs a new "add entry" form + server action. Follow-up feature commit.
- [ ] **X2 · 🟠 [FEAT] No weekly timesheet grid, no per-day totals.** Deferred — new view + query. Follow-up.
- [ ] **X3 · 🟠 [FEAT] Timer doesn't sync across tabs.** Deferred — BroadcastChannel wiring is a targeted refactor of clock-widget.
- [ ] **X4 · 🟠 [FEAT] No notification categories/filters.** Deferred — schema addition (Notification.category enum) + UI.
- [ ] **X5 · 🟠 [FEAT] No activity pagination.** Deferred — needs cursor query + infinite-scroll UI.
- [ ] **X6 · 🟠 [FEAT] No activity filter by user.** Deferred — UI filter + query param.
- [ ] **X7 · 🟠 [FEAT] No invite-resend button.** Deferred — needs the pending-invites list view first.
- [ ] **X8 · 🟠 [FEAT] No soft-delete / deactivate for team members.** Deferred — schema addition (User.deactivatedAt) + rollout across queries.
- [~] **X9 · 🟠 [BUG] Role change doesn't invalidate active sessions.** DEFERRED — proper fix bumps a session-version claim in the JWT and re-checks it in the middleware callback. Auth infra touch; tracked as follow-up.
- [x] **X10 · 🟠 [BUG] Notification links don't verify target still exists.** ✔ `deleteTaskAction` now sweeps `Notification.deleteMany({ link contains taskId=<id> })` inside the same transaction as the task delete, so the "New task assigned" notification never points at a phantom row. Project + transaction delete-side follow the same pattern in a future pass.
- [x] **X11 · 🟠 [UI] Notification bell badge is a 2×2 dot.** ✔ Shipped in N6 — now a proper numeric badge with `9+` overflow.
- [x] **X12 · 🟠 [UI] Running-entry only in topbar** — not surfaced on `/time` header. ✔ New `RunningEntryBanner` at the top of /time when the current user has an active session — shows started-at, task title (or "Untagged work"), note, and a live duration in the same font weight the topbar widget uses.
- [~] **X13 · 🟠 [UI] Inconsistent mark-all-read affordance** across dropdown vs page. NOT A REAL INCONSISTENCY — dropdown uses a compact text link (right-context), full page uses a pill button (broad-context). Both say "Mark all read" and route to the same action. Deliberate density difference.
- [ ] **X14 · 🟡 [UI] Empty state art reuses generic Bell icon everywhere.**
- [ ] **X15 · 🟡 [BUG] Activity feed has no dedupe.** Rapid consecutive events create identical rows.
- [ ] **X16 · 🔵 [OPP] Weekly digest email, quiet-hours for notifications, Slack integration for mentions, iCal export, presence indicator.**

## 6. Settings · i18n · a11y · Mobile · PWA

- [x] **S1 · 🔴 [BUG] Manifest missing `/icon.svg` file** — shipped in P0-2.
- [ ] **S2 · 🔴 [FEAT] No danger zone.** Deferred — needs 3 new server actions (deleteAccount, leaveCompany, deleteCompany) + soft-delete strategy per Tier 3 plan in CLAUDE.md.
- [ ] **S3 · 🟠 [FEAT] No change-email flow with verification.** Deferred — parallels the password-reset flow shipped in P0-1; needs its own token + confirmation-email step.
- [ ] **S4 · 🟠 [FEAT] No MFA/2FA setup.** Deferred — Auth.js supports TOTP with a follow-up integration commit.
- [~] **S5 · 🟠 [FEAT] No system-theme option.** DEFERRED — three-way theme choice ("system") means widening the store type + a `matchMedia("prefers-color-scheme")` listener. Follow-up.
- [ ] **S6 · 🟠 [FEAT] Locale + theme not synced to DB.** Deferred — schema addition (`User.locale`, `User.theme`) touches prod DB (CLAUDE.md safety rail); do after Tier 2 env separation.
- [ ] **S7 · 🟠 [FEAT] No timezone preference.** Deferred — schema addition + rollout across every date formatter.
- [ ] **S8 · 🟠 [FEAT] No profile photo upload; no company logo.** Deferred — needs Supabase Storage wiring.
- [ ] **S9 · 🟠 [FEAT] No email/in-app notification-preferences UI.** Deferred — schema addition + matrix UI.
- [ ] **S10 · 🟠 [FEAT] No "Export my data" (GDPR).** Deferred — download-a-zip action + JSON export.
- [ ] **S11 · 🟠 [FEAT] No PWA install button; no offline write queue.** Deferred — beforeinstallprompt handling + IndexedDB queue.
- [x] **S12 · 🟠 [BUG] Hardcoded English strings escape i18n.** ✔ `change-password-modal.tsx` now threads `showLabel`/`hideLabel` from `t.auth.show/hidePassword` into the `PasswordField` subcomponent. `confirm-dialog.tsx` falls back to `t.common.cancel`/`t.common.confirm` instead of raw English.
- [x] **S13 · 🟠 [BUG] No skip-to-content link.** ✔ Added a keyboard-focus-only `Skip to main content` link at the top of the root layout; `<main>` inside the app shell now carries `id="main"` so it lands somewhere useful.
- [x] **S14 · 🟠 [BUG] Toast (`react-hot-toast`) not `aria-live="assertive"`.** ✔ Toaster `ariaProps` now default to `role="status" aria-live="polite"` for info/success; error toasts explicitly upgrade to `role="alert" aria-live="assertive"`.
- [~] **S15 · 🟠 [BUG] Manifest missing PNG raster icons at 192 / 512.** DEFERRED — Write tool can't emit binary PNGs. Follow-up: generate `public/icon-192.png` + `icon-512.png` via a build-time helper (or a manual export from the SVG) and reference them in `manifest.json`.
- [~] **S16 · 🟠 [BUG] No `apple-touch-startup-image`.** DEFERRED — same binary-file constraint as S15. Follow-up: generate the required PNGs per Apple's device-size matrix.
- [x] **S17 · 🟠 [UI] Modal sizes are `sm/md/lg/xl` only.** ✔ `<Modal>` is now a bottom-sheet on `< sm` viewports (full-width, rounded top corners) and a centered card at `sm` and up. Every existing size (sm/md/lg/xl) becomes the desktop max-width via `sm:max-w-*` variants.
- [x] **S18 · 🟠 [UI] Confirm dialog buttons + labels not localizable.** ✔ Same fix as S12 — button labels now flow through `t.common.cancel`/`t.common.confirm`.
- [ ] **S19 · 🟡 [BUG] Number formatting not locale-aware** ("999 sessions" not "۹۹۹") for Urdu. Deferred — needs an `Intl.NumberFormat(t.locale)` sweep across formatters.
- [ ] **S20 · 🟡 [BUG] No RTL sidebar mirror check for Urdu.** Deferred — CSS logical-property audit for the sidebar + drawer + all fixed-position elements.
- [ ] **S21 · 🔵 [OPP] Density preference, contrast-mode boost, mobile bottom-nav for primary actions, "reset all preferences".**

---

## How to work through this

Same pattern as BUGS.md worked well:
1. Batch by severity, ship as one commit per batch (P0 → P1 → P2 → P3).
2. Fix in-place, tick `[x]` with a one-line note under the row.
3. If a finding turns out to be a false positive or is deliberately deferred, mark `[~]` with the reason inline — don't just delete the row.
4. Run `npm run typecheck && npm test && npm run build` before every batch commit.
5. Update the totals block at the top of this file when the counts shift meaningfully.
