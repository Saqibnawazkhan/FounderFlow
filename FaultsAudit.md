# FounderFlow — faults audit

> ## Production-delivery hardening — 2026-07-06
>
> An 8-dimension staff-level audit (deploy, DB, security, UI, testing,
> dead-code, performance, completeness) fed a phased delivery. **Shipped:**
> **P1 · data integrity** — `deletedAt: null` added to every scoped
> transaction/task/budget/project read + their groupBy/aggregate spend paths;
> recurring materializer skips soft-deleted workspaces; `deleteProjectAction`
> now soft-deletes; **the destructive purge cron is DRY-RUN by default**
> (`PURGE_ENABLED` gate) so no job auto-deletes customer data.
> **P2 · security** — rate-limit key moved off the spoofable `x-forwarded-for[0]`
> to the trusted `x-real-ip`; one strong password policy across signup/invite/
> reset/change-password; reset tokens made genuinely single-use (hash-bound
> `pv` claim); constant-time cron-secret compare; Sentry ingest allowed in CSP.
> **P3 · currency** locked to PKR (the multi-currency picker was a no-op given
> `formatCurrency` ignores it — F4). **P4 · deploy** — region pinned `sin1`
> (co-located with Supabase `ap-southeast-1`), Node pinned, **CI now runs the
> test suite**, prod build fails on missing `DATABASE_URL`/`AUTH_SECRET`/
> `DIRECT_URL`, `favicon.ico` served, cron `maxDuration`. **P5 · perf** — 5000-row
> ceiling on the unbounded transaction read + `(companyId,order)`/`(projectId,order)`
> task indexes. **P6 · UI** — EmptyState onto theme tokens, danger confirms
> focus Cancel, budgets/recurring loading skeletons, time mobile cards, Urdu
> toggle honestly labelled beta. **P7 · cleanup** — scratch gitignored, stale
> SQLite schema header fixed.
>
> **Purge made safe to enable** (follow-up done): rather than the risky FK →
> SetNull refactor across the core model, the purge cron now deletes each
> overdue workspace in explicit dependency order inside a transaction (never
> trips a `Restrict` FK) and has **no individual-user purge stage** — a
> deactivated user in a live workspace keeps their content, fixing the
> cascade-data-loss + Restrict-jam without any schema/type change.
> `PURGE_ENABLED` is still off by default (owner decides when erasure runs).
>
> **Deferred (documented, not launch-blocking):** server-side transaction
> windowing + dashboard groupBy for high volume; `/projects` TimeEntry raw-SQL
> sum; app-shell round-trip trim; `/reports` mobile card; full Urdu page
> coverage + RTL; nonce-based CSP; shared (Upstash/KV) rate-limit store; the
> dead `lib/store.ts` data-layer + `lib/seed.ts` removal; full GDPR
> anonymization of an individual account's PII in a live workspace.
>
> **Owner actions (I can't/didn't do):** rotate the secrets in the stale root
> `.env` (live prod Supabase creds — Prisma CLI reads it by default, so
> `db:migrate:local` could hit prod) and delete that file; provision the shared
> rate-limit store; confirm the Supabase region matches the `sin1` pin.

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
- **18 `[ ]` still open** (recounted 2026-09-26 by counting the actual checkboxes, not by adjusting the previous number. **Current tally: 73 `[x]` done / 19 `[~]` partial / 18 `[ ]` open, 110 rows.**) This figure has now drifted twice — the original "46" was never updated as rows were ticked, and the 2026-09-23 recount to "14" went stale the same way within three days, because rows get ticked in the body and nobody comes back up here. The honest reading is that any number written in this header is a snapshot with a short half-life: **count the checkboxes rather than trusting this line**, and if you change a row, change this too or delete the tally outright. The open set is a mix of P1 feature-shaped work (bulk edit, CSV import, MFA, timezone preference, categories) and the §8 rows filed on 2026-09-26, several of which are small.

Commits: `61efaba` (P0) · `89b8298` (Auth+Nav) · `1f8c4fb` (Tasks+Projects) · `88263e2` (Finance) · `388bb02` (Time+Notif) · `68bac72` (Settings+i18n+a11y+PWA).

---

## Top of the sweep — P0 batch

These are the ones I'd take first. Ship as one PR each, or bundle P0-1 through P0-6 as a single "trust batch".

- [x] **P0-1 · [FEAT] No password-reset flow.** ✔ Shipped `/forgot-password` + `/reset-password` routes, `requestPasswordResetAction` + `resetPasswordAction`, HMAC-signed stateless JWTs (`lib/auth/password-reset-token.ts`) so no schema change was needed, email sent via existing Gmail SMTP infra, "Forgot password?" link now on the login form, allow-listed in `auth.config.ts`, i18n (en + ur) covered.
- [x] **P0-2 · [BUG] Manifest references `/icon.svg`, file doesn't exist.** ✔ Copied `app/icon.svg` → `public/icon.svg` so the SW precache + manifest URL both resolve. `app/icon.svg` stays as Next.js's file-based metadata for the auto `<link rel="icon">`.
- [x] **P0-3 · [BUG] Topbar search input is a placeholder-only stub.** ✔ Wired to a new `CommandPalette` component (fuzzy nav-jump), globally bound to ⌘K / Ctrl-K, respects member-blocked routes. Extracted shared nav list to `lib/nav.ts` so the palette + sidebar stay in sync.
- [x] **P0-4 · [BUG] Money stored as `Float` (Prisma), not `Decimal`.** ✔ Shipped 2026-07-02 after Tier 2 unlocked local rehearsal. Migration `20260702003431_money_float_to_decimal` promotes `Transaction.amount`, `RecurringRule.amount`, and `Budget.monthlyLimit` from PostgreSQL `DoublePrecision` → `Decimal(12,2)`. Prisma now returns `Prisma.Decimal` on read; conversion to plain `number` happens at the query/action boundary (`lib/queries/transactions.ts`, `budgets.ts`, `recurring.ts`, `projects.ts`, `lib/actions/transactions.ts`, `lib/budgets/check.ts`) so the RSC/client layer keeps its number-shaped API. Zod `.number()` on the write side is unchanged — Prisma accepts a number and stores it as Decimal. Tests updated to seed rules with `new Prisma.Decimal(...)`. Fixed a piggyback env-validator bug where `""` for `SENTRY_DSN` / `UPSTASH_REDIS_REST_URL` tripped `z.string().url().optional()` — now preprocessed to `undefined`.
- [x] **P0-5 · [BUG] Task notifications link to `/tasks`, not the specific task.** ✔ Both task-assigned + task-completed notifications now emit `/tasks?taskId=<id>`; `tasks-client.tsx` reads the query param, scrolls the target card/row into view, and flashes a 2.5s highlight ring before wiping the param.
- [x] **P0-6 · [FEAT] No favicon.ico, no OG image.** ✔ Explicit `icons` metadata (icon + shortcut + apple all point at `/icon.svg`), plus a new dynamic `app/opengraph-image.tsx` that renders a 1200×630 gradient card on-demand via `next/og`. Manifest already had icon entries — those keep working.

---

## 1. Auth · Onboarding · Landing

- [x] **A1 · 🔴 [FEAT] No password-reset flow** — shipped in P0-1.
- [x] **A2 · 🔴 [FEAT] No email verification post-signup.** ✔ Shipped 2026-07-04 (soft gate). `User.emailVerifiedAt` column + migration; HMAC-signed stateless verification token (`lib/auth/email-verification-token.ts`, 7-day TTL, `purpose` claim so it can't cross with reset tokens); email fired fire-and-forget from `signupAction`; `/verify-email?token=` page verifies (token-scoped, works logged-out); a dismissible app-shell banner (`VerifyEmailBanner`) reads live DB status on mount + offers Resend. Nothing is blocked while unverified — the `EMAIL_VERIFICATION_REQUIRED` env flag is reserved for a future hard gate. en + ur i18n.
- [x] **A3 · 🔴 [FEAT] No account deletion (GDPR/CCPA gap).** ✔ Shipped alongside S2 — soft-delete (Tier 3) so recovery is possible for 90 days.
- [x] **A4 · 🔴 [FEAT] No favicon + OG image** — shipped in P0-6.
- [x] **A5 · 🟠 [FEAT] Admin can't generate/manage invite tokens from UI.** ✔ Fully resolved. Creation always existed (Invite member button + modal); the missing management side shipped under **X7** — the admin-only Pending invites panel now lists every unused invite with resend (token-rotating) + revoke controls.
- [x] **A6 · 🟠 [UI] Password inputs lack `maxLength`; email lacks `inputMode="email"`.** ✔ Login + signup emails now carry `inputMode="email" maxLength={254}`, passwords `maxLength={256}`. Signup name `maxLength={80}`.
- [x] **A7 · 🟠 [UI] No autofocus on first field.** ✔ `autoFocus` on the first field of login (email) and signup step-1 (name), with an inline eslint-disable + rationale ("landing on a dedicated auth page; first-field autofocus is expected").
- [x] **A8 · 🟠 [UI] Password eye-toggle has no `:focus-visible` ring.** ✔ Added `focus-visible:ring-2 focus-visible:ring-primary/50` to the toggle button on login, signup, and the new reset-password page.
- [~] **A9 · 🟠 [BUG] Rate-limit message "Too many requests" is opaque.** Partial false positive — [lib/rate-limit.ts:103](lib/rate-limit.ts#L103) already returns `"Too many requests. Try again in Xs."`. The toast surfaces that verbatim via `gate.error`. A LIVE countdown timer is a P3 nice-to-have, not a P1.
- [~] **A10 · 🟠 [BUG] Session expiry silently 401s server actions.** DEFERRED — a proper fix means a global "action result" interceptor or wrapping every callsite. Middleware already redirects expired sessions on the next navigation; the only silent case is mid-session for a single action call, which shows a toast. Full fix tracked as follow-up under a broader "auth error boundary" line item.
- [~] **A11 · 🟡 [UI] Landing hero contrast risk.** FALSE POSITIVE — `--primary-strong` is a theme-aware token already contrast-tuned per theme (light: lime-700, documented ~6.3:1 on `#f7f8f5`; dark: bright lime ~14:1 on near-black). The hero gradients behind it are 0.10-0.12 opacity tints that don't move the ratio below AA.
- [x] **A12 · 🟡 [OPP] No welcome tour / empty-state guidance post-signup.** ✔ Shipped a `GettingStarted` checklist on the dashboard (2026-07-04): four steps (record capital, log expense, create task, invite co-founder) whose done-state derives from live data — the card fills in as they work and disappears at ≥3 of 4 done. No dismissal state needed; the data is the dismissal.
- [ ] **A13 · 🔵 [OPP] Magic-link login, sign-in-with-Google, 2FA / TOTP.** → [auth.config.ts](auth.config.ts)

- [x] **A14 · 🔴 [BUG] Login form can submit before hydration, putting the password in the URL.** Caught in a dev-server log as `GET /login?email=demo%40founderflow.app&password=demo123`. The `<form>` declares no `method`, so a click that lands before React hydrates performs a NATIVE submit — which defaults to GET — and the credentials end up in the query string, the server access log, browser history and any `Referer` header. Needs a slow first paint to trigger (cold compile, slow network, cheap phone), so it is rare rather than theoretical; `scripts/smoke-tasks-calendar.mjs` now retries sign-in specifically because it hit this. Fix: `method="post"` on the form, or keep the submit disabled until hydrated. → [app/login/page.tsx](app/login/page.tsx) ✔ Fixed 2026-09-26. Audited all FIVE public auth forms, not just login — they came from one template and four were affected. `reset-password` was the worst payload (hidden token + new password in one URL) and, like `forgot-password` and `invite`, was reachable by **Enter**, not only a click: login needed a click because two blocking fields suppress implicit submission. Signup was not exploitable, but only as an accident of its two-step layout, so it was fixed anyway. Both halves shipped: `method="post"` as the safety net, plus a hydration gate (`lib/hooks/use-hydrated.ts`) that renders the submit button `disabled` in the server HTML so the native submit never fires. `tests/components/auth-forms.test.tsx` WALKS `app/` for public pages carrying a credential field rather than naming five paths, so a sixth auth form fails there instead of shipping this again.

## 2. Dashboard · Nav · Global shell

- [x] **N1 · 🔴 [BUG] Topbar search stub** — shipped in P0-3 (command palette + ⌘K).
- [x] **N2 · 🟠 [FEAT] No breadcrumbs anywhere.** ✔ A path-driven `Breadcrumbs` bar hoisted into the app shell (renders on every route, no per-page wiring). Known segments use their localized `t.nav.*` label; a dynamic id under `/projects/[id]` renders a generic "Project" crumb (the page H1 carries the real name), and the leading Home link routes to the **role's** home so a member never lands on a finance page. `aria-label="Breadcrumb"` + `aria-current="page"` on the leaf; i18n en + ur. (Also folded in an S6 coherence fix: the topbar's quick theme/locale toggles now persist to the DB like the settings controls.)
- [x] **N3 · 🟠 [FEAT] No language switcher in UI.** ✔ Added a `Languages` icon button in the topbar (between clock widget and theme toggle). Two-locale toggle (en ↔ ur); would upgrade to a dropdown if we add a third locale.
- [x] **N4 · 🟠 [FEAT] No desktop sidebar-collapse toggle.** ✔ New `sidebarCollapsed` in the persisted store; sidebar shrinks to a 64 px icon rail with an inline `⟵ Collapse / ⟶` toggle in its footer; app layout's left margin animates between `lg:ml-64` and `lg:ml-16`.
- [x] **N5 · 🟠 [UI] Sidebar active-state too subtle.** ✔ Stronger `border-primary/50 bg-primary/[0.14]` + a 2 px inset shadow rail + colored icon.
- [x] **N6 · 🟠 [UI] Duplicate notification affordance.** ✔ Replaced the topbar 2×2 dot with a proper numeric badge (`9+` when over). Sidebar still counts; the two now agree instead of racing.
- [~] **N7 · 🟠 [BUG] No scroll-restoration between route transitions.** DEFERRED — Next.js 14 App Router scroll-restores by default on `<Link>` nav and browser back/forward; audit finding needs empirical verification against a real regression, not blind wiring.
- [~] **N8 · 🟠 [BUG] Hydration paint flash from Zustand skeleton.** DEFERRED — proper fix moves `currentUser` hydration into a Suspense boundary in Providers so the layout renders in the same paint as content. Full refactor for a future session.
- [x] **N9 · 🟡 [UI] Sparse / inconsistent page metadata.** ✔ Mostly a stale finding — every (app) page already had title + full-sentence description and the root layout supplies the `%s · FounderFlow` template. Real gap was the client-component auth pages (forgot-password, reset-password) falling back to the default title; added thin metadata layouts for both (login/signup already had them). 2026-07-04.
- [x] **N10 · 🟡 [UI] 404 doesn't suggest related pages; offline page has no cached-page list.** ✔ 404 now offers Dashboard / Tasks / Projects buttons + a ⌘K tip and uses the app's design tokens. Offline page: a cached-page list would list nothing (the SW deliberately never caches documents — navigations are network-first), so fixed the misleading "your last-cached pages still work" copy instead. 2026-07-04.
- [~] **N11 · 🔵 [OPP] Cmd-K palette, recent-items widget, activity ticker, install-PWA button.** PARTIAL — the Cmd-K palette shipped back in P0-3. Recents/ticker/install-button stay long-horizon.

- [x] **N12 · 🟠 [BUG] `/icon.svg` returns 500.** `app/icon.svg` (the App Router metadata convention) and `public/icon.svg` both claim the same route, and Next serves an error page for it on every page load. **Pre-existing, not rebrand fallout** — verified by restoring the pre-rebrand icon, which 500s identically. The browser tab still resolves via `favicon.ico`, but `public/manifest.json` lists `/icon.svg` among the PWA icons, so that entry is dead. Fix: keep one of the two files. → [app/icon.svg](app/icon.svg), [public/icon.svg](public/icon.svg) ✔ Fixed 2026-09-26. `app/icon.svg` deleted; `public/icon.svg` is the single owner of the route and `app/layout.tsx` points its metadata at it. Diagnosis went past the 500: the two files were byte-identical, and the embedded PNG is **256×256 upscaled 2× into a 512 box**, contradicting `scripts/_gen-brand-assets.mjs`'s own comment claiming nothing is up-scaled. That generator was ALSO still writing `app/icon.svg`, so the next asset rebuild would have reintroduced the collision — that write is removed and the false comment replaced. All four `manifest.json` icons verified to resolve. Remaining: the icon is still a 69KB raster-in-SVG — see N13.

## 3. Tasks · Projects · Comments

- [x] **T1 · 🔴 [BUG] Task notification deep-link broken** — shipped in P0-5.
- [~] **T2 · 🔴 [BUG] N+1 on project list.** FALSE POSITIVE — [lib/queries/projects.ts:124-128](lib/queries/projects.ts#L124-L128) already scopes `where: { projectId: { in: projectIds } }` and pulls only 3 columns. JS-side aggregation via `durationMs` is intentional so the still-running clock (null `clockOutAt`) counts against `now`. No SQL rewrite would help without losing that semantic.
- [x] **T3 · 🟠 [FEAT] No kanban drag-reorder, no bulk edit, no bulk delete.** ✔ Fully shipped 2026-07-04 across two commits. **Bulk edit + delete:** list view has per-row + select-all checkboxes and a floating action bar (bulk "Move to <status>" + Delete); actions `bulkUpdateTaskStatusAction` / `bulkDeleteTasksAction` push the single-task permission rule into a scoped `updateMany`/`deleteMany`, emit ONE summary activity row, sweep task-deep-link notifications, fire the bulk-mutation canary, and report skipped rows honestly. **Drag-reorder:** added `Task.order Float` (migration backfills `-epoch(createdAt)` to preserve newest-first); board migrated from `useDraggable` to `@dnd-kit/sortable` (`SortableContext` per column + `useSortable` cards, with the card body extracted to a hook-free `TaskCardView` so the DragOverlay never duplicates a sortable id). `handleDragEnd` splits cross-column (status change, unchanged) from same-column (reorder via midpoint `order` → `reorderTaskAction`, one-row write). NOTE: the drag *interaction* itself needs a real-device check — static checks (typecheck/tests/build) all pass but pointer-drag can't be simulated in the build env.
- [x] **T4 · 🟠 [FEAT] Task filters limited to all/mine/assigned-by-me.** ✔ Added a secondary filter bar on `/tasks` that stacks on top of the relationship filter: **Priority** (any/urgent/high/medium/low), **Project** (all + one option per live project), and **Due** (any/overdue/due today/next 7 days/no deadline). Each persists to `localStorage` (matching T5), shows an active-state ring, and a live result count. A "Clear filters" pill appears when any secondary filter is set, and a selected project that gets archived/deleted auto-resets to "all" so the list never silently shows nothing.
- [x] **T5 · 🟠 [FEAT] Filters don't persist.** ✔ `view` + `filter` now round-trip through `localStorage` (`ff.tasks.view`, `ff.tasks.filter`) with a private-mode-Safari safe try/catch.
- [x] **T6 · 🟠 [FEAT] No @mention autocomplete UI.** ✔ The comment composer now shows a floating listbox as you type `@`. `findMentionQuery` (in [lib/comments/mentions.ts](lib/comments/mentions.ts), unit-tested — 7 cases) detects the in-progress token under the caret using the same start-of-word rule the server parser enforces, so an email-style `foo@bar` never triggers it. Candidates are the company roster (minus self) filtered by slug/name; keyboard-navigable (↑/↓ move, Enter/Tab accept, Esc dismiss) with full ARIA combobox wiring (`aria-activedescendant`, `role="option"`), and mouse-select via `onMouseDown`-preventDefault so the textarea never blurs mid-pick. Accepting inserts `@slug ` and restores the caret after it.
- [x] **T7 · 🟠 [FEAT] No archived-project unarchive button.** ✔ Added a "Restore" button (ArchiveRestore icon, primary tone) that shows only when `project.status === "archived"`; calls `updateProjectAction` with `status: "active"`. i18n keys added in en + ur.
- [x] **T8 · 🟠 [UI] Priority is color-only in cards + list.** ✔ Added a `PRIORITY_ICONS` map (`AlertOctagon`, `ArrowUp`, `Minus`, `ArrowDown`) rendered inside the pill so priority now carries color + text + shape (three redundant channels for a11y).
- [~] **T9 · 🟠 [UI] Overdue indicator only in list view, missing from kanban cards.** FALSE POSITIVE — the board card at [tasks-client.tsx:739](app/(app)/tasks/tasks-client.tsx#L739) already renders `AlertCircle` on overdue rows. Auditor missed the second render site.
- [x] **T10 · 🟠 [BUG] Optimistic drag-drop status change doesn't rollback.** ✔ We now capture `priorStatus` before the optimistic write and restore the exact prior column on server error, before the `router.refresh()` round-trip.
- [x] **T11 · 🟠 [BUG] Comment badge count stale after post.** ✔ The tasks page's `CommentThreadModal` `onChanged` handler now optimistically bumps `commentCount + 1` on the target card before `router.refresh()` corrects the canonical number.
- [ ] **T12 · 🟡 [FEAT] No subtasks, dependencies, tags/labels, attachments, recurring tasks.** → [lib/schemas/task.ts:7-27](lib/schemas/task.ts#L7-L27)
- [~] **T13 · 🟡 [FEAT] No project templates / "duplicate project".** ◐ Half shipped 2026-09-26. `duplicateProjectAction` + `DuplicateProjectSchema` + a per-card Duplicate control now copy a project's structure. The correctness boundary is explicit and tested: a duplicate copies tasks (status reset, assignees cleared, deadlines shifted rather than kept in the past) and copies NO money or history — duplicating a transaction would invent revenue that never happened. **Templates are still open**: a saved, named, reusable shape is a different product idea and deserves its own decision, so this row stays `[~]` rather than closing on the easier half.
- [ ] **T14 · 🔵 [OPP] Inline task edit, quick-add row, keyboard shortcuts (N/Esc/⌘K), ICS calendar export, project Gantt.**

- [x] **T15 · 🟡 [BUG] /tasks filter choices reset on refresh in development.** `reactStrictMode` double-invokes effects: the `[filter]` / `[priorityFilter]` / `[projectFilter]` / `[dueFilter]` writers fire holding the PREVIOUS render's value and clobber what the restore effect just read, so the second restore reads the clobbered value back. Production runs effects once and is unaffected, which is why the smoke suite never caught it — it ran against `npm start`. The `view` persister was fixed 2026-09-24 by writing in the click handler instead (`chooseView`); the remaining four still use the effect form. Same one-line fix each. → [app/(app)/tasks/tasks-client.tsx](app/(app)/tasks/tasks-client.tsx) ✔ Fixed 2026-09-26. All four remaining persisters moved out of effects into a single `persist(key, value)` helper called from the change handlers, matching the `chooseView` fix. Verified structurally: `localStorage.setItem` now appears exactly once in the file and inside no `useEffect`, so StrictMode's double invocation has nothing to clobber.

## 4. Finance — budgets, expenses, investments, reports, recurring

- [x] **F1 · 🔴 [BUG] `Float` money type + client-side sums** — shipped with P0-4 on 2026-07-02.
- [x] **F2 · 🟠 [FEAT] No CSV/XLSX import for transactions.** ✔ CSV import shipped on both `/expenses` and `/investments`. `ImportTransactionsModal` picks a file, auto-detects the date/amount/category/description columns, and shows a validated preview (per-row valid/skipped with reasons) before anything saves; a "Download template" link seeds the format. `parseCSV` (extracted to [lib/transactions/csv.ts](lib/transactions/csv.ts), 9 unit tests — quoted fields, escaped quotes, embedded newlines, CRLF) does the parsing. `bulkImportTransactionsAction` re-validates every row server-side (categories especially — unknown ones are dropped + counted, never trusted from the client), inserts via one `createMany`, logs a single summary activity, fires the bulk-mutation canary, and deliberately skips per-row notifications so importing history doesn't spam the team. (It skipped the budget-threshold check too, until transactions-ledger-004: the batch now takes an optional project tag — the modal has a picker — and an expense import judges each distinct category's cap once after the batch. Untagged imported spend crossed no cap at all, because every `Budget` belongs to a project, so "no threshold check on import" meant budgets did nothing for anyone who onboarded by importing.) (XLSX import not included — CSV is the universal export format; note kept as an opportunity.)
- [ ] **F3 · 🟠 [FEAT] No receipt/attachment field on transactions.** Deferred — needs object storage wiring (Supabase Storage) + schema migration + upload UI. P2 feature commit.
- [x] **F4 · 🟠 [FEAT] No multi-currency.** ✔ SHIPPED (commit `5bb359c`, per-workspace currency chosen at signup). `lib/hooks/useMoney.ts` is the `useCurrencyFormatter()` hook this row called for, seeded from the app-layout RSC and consumed by 15 call sites; `lib/schemas/auth.ts:29` validates `currency: z.enum(SUPPORTED_CURRENCIES)`; `Company.currency` (schema.prisma:120) still defaults to `"PKR"`. Smoke: `scripts/smoke-currency.mjs`. Residual: a few hardcoded "(PKR)" *labels* remain — see the follow-ups list. Original deferral rationale below, kept for context. ~~DEFERRED (evaluated 2026-07-04).~~ `formatCurrency(amount, currency)` already accepts a code and `Company.currency` already exists — the gap is a settings picker to set it plus threading the company currency through **48 `formatCurrency(...)` call sites across 15 files**, most in client components that don't have the company in scope. The clean way is a `CurrencyProvider` context seeded from the app-layout RSC + a `useCurrencyFormatter()` hook, then a mechanical sweep of all 48 sites. That's a focused rollout best verified against a running app (a half-threaded sweep would show PKR in some places and the new currency in others — worse than today). Product is PKR-first (CLAUDE.md, `NEXT_PUBLIC_DEFAULT_CURRENCY=PKR`), so this is genuinely a "Follow-up" epic, not a quick win. No FX conversion is in scope — display currency only.
- [x] **F5 · 🟠 [FEAT] Reports offer only 6 preset ranges.** ✔ Added a **Custom** option with from/to date inputs alongside the presets. Crucially the whole report now scopes to the selected window — cash-flow chart, category mix, per-founder totals, AND the PDF/Excel exports (which stamp the date range) — where previously the presets only moved the cash-flow chart while the totals stayed all-time. A reversed range is forgiven (swapped) instead of showing nothing.
- [ ] **F6 · 🟠 [FEAT] Categories hardcoded in `EXPENSE_CATEGORIES`.** DEFERRED (evaluated 2026-07-04). A proper fix is a `Category` model + per-company CRUD + settings UI, but the ripple is real: (1) a migration that **back-fills default categories for every existing company** and the signup flow must seed them for new ones; (2) `NewTransactionSchema` currently validates `category` against a **static union** — it would have to become a dynamic per-company check inside the action, changing the validation model; (3) rewiring the transaction form, both category filters, and coexisting with budgets that key on category strings; (4) delete-guarding a category that has transactions. That's a multi-file epic with correctness risk (empty-category companies, in-use deletes) best done in its own focused pass with device verification — not rushed alongside four other finance changes. The hardcoded lists are complete + usable meanwhile.
- [x] **F7 · 🟠 [UI] Amount inputs lack `inputMode="decimal"`.** ✔ Added `inputMode="decimal"` to transaction, recurring, and budget-monthlyLimit money inputs; recurring `dayOfMonth` gets `inputMode="numeric"` so mobile keyboards match the field.
- [~] **F8 · 🟠 [UI] No negative/reversal color coding.** FALSE POSITIVE — schema at [lib/types.ts:23](lib/types.ts#L23) is `TransactionType = "expense" \| "investment"`. There is no refund/reversal concept, so no third color to give it.
- [x] **F9 · 🟠 [UI] Budget progress uses color alone for status.** ✔ Progress bar now has `role="progressbar"` + `aria-valuenow` + a descriptive `aria-label`; over-budget bars gain a diagonal-stripe pattern layered on top of the danger color so color-blind users can still tell them apart. Existing "Over / Warning / On track" text pill was already redundant with color.
- [x] **F10 · 🟠 [UI] Tables have no cards fallback for mobile.** ✔ The `/expenses` and `/investments` tables are now `hidden md:block`, with a `md:hidden` card list carrying the same rows + actions (comment, delete). Phones get readable cards instead of a horizontally-scrolling table. (Time + reports tables still scroll — same pattern applies when they get a mobile pass; tracked as remaining polish.)
- [~] **F11 · 🟠 [BUG] Budget threshold state per-budget, not per-(budget, user).** LARGELY COVERED — `lastWarnedMonth` / `lastAlertedMonth` per-Budget dedupe blocks the common case (single-user session). Only concurrent-writes race can double-fire; low risk at this scale. Full per-(budget, user) tracking would need a schema addition — defer.
- [x] **F12 · 🟠 [BUG] `formatCurrency` special-cases PKR** inconsistently. ✔ Removed the PKR-only prefix branch; every currency now flows through `Intl.NumberFormat` uniformly, with a safe fallback for stale/unknown ISO codes.
- [x] **F13 · 🟠 [BUG] Export buttons on `/reports` don't re-check `canSeeFinances` client-side.** ✔ The RSC now `notFound()`s for member roles as belt-and-braces beyond middleware. Both the button-render and export-action paths are protected in one gate.
- [ ] **F14 · 🟡 [FEAT] No split transactions, no tax categories, no vendor/merchant field.**
- [~] **F15 · 🔵 [OPP] Dashboard runway/burn-rate widget, monthly closeout email, spend-vs-budget trend chart, anomaly alerts, duplicate-transaction button.** PARTIAL — the runway figure already ships on the dashboard's Balance KPI ("61.3 mo runway" delta label). The rest stay long-horizon.

## 5. Time · Notifications · Activity · Team

- [x] **X1 · 🟠 [FEAT] No manual/backdated time entry.** ✔ A **Log time** button on `/time` opens a modal to record a *completed* session (start + end both required, live duration preview). `createManualEntryAction` is self-scoped — any member can log their own forgotten work with no elevated permission. `CreateManualEntrySchema` (7 unit tests) guarantees end > start and neither end is in the future; `lastActivityAt` pins to clock-out so a manual row can never trip the idle sweeper.
- [x] **X2 · 🟠 [FEAT] No weekly timesheet grid, no per-day totals.** ✔ A **List ↔ Week** toggle (persisted to localStorage) on `/time`. The Week view (`components/time/weekly-timesheet.tsx`) buckets the loaded entries into a Mon–Sun grid with per-day totals, a week total, prev/next/"This week" navigation, and today highlighted; team scope tags each row with the person. Pure client-side over the RSC's entries — no extra query (the 500-newest server cap is the only bound, noted here).
- [x] **X3 · 🟠 [FEAT] Timer doesn't sync across tabs.** ✔ A shared `BroadcastChannel("ff-time")`. The topbar clock widget posts `time-changed` on clock-in / clock-out / auto-close so every other tab re-fetches its open-entry state and the running pill agrees everywhere; `/time` both listens (refreshes on any timer change) and posts on its own writes (manual log / edit / delete). `reload()` never posts, so there's no echo loop; falls back to a silent no-op where `BroadcastChannel` is unavailable.
- [x] **X4 · 🟠 [FEAT] No notification categories/filters.** ✔ Added a `Notification.category` column (`task | finance | team | system`, default `system`, migration `20260704145714_add_notification_category`) — tagged at all 10 creation sites (budget alerts → finance even though they link to `/projects`, so a derived-from-link category would have mislabelled them; comment mentions inherit their target's category). The notifications page gained category filter chips with live counts plus an "Unread only" toggle. Historical rows default to System.
- [x] **X5 · 🟠 [FEAT] No activity pagination.** ✔ Real cursor pagination. `getActivitiesPage` returns 40 rows + a `nextCursor` (ordered `createdAt desc, id desc` so same-ms rows page deterministically, fetch-one-extra to detect the end); the client seeds from the RSC's first page and a "Load more" button appends via `loadMoreActivitiesAction`, de-duping by id on append. Client search/type filters apply to loaded rows (noted inline in the UI).
- [x] **X6 · 🟠 [FEAT] No activity filter by user.** ✔ A "person" `<select>` (Everyone + each teammate) on `/activities` that drives a `?user=<id>` URL param, so the server re-queries from page 1 filtered to that actor and pagination continues within the filter. A stale `?user=` for someone off the roster falls back to Everyone.
- [x] **X7 · 🟠 [FEAT] No invite-resend button.** ✔ Shipped a **Pending invites** panel on `/team` (admin-only) listing every unused invite with an Awaiting/Expired badge. `resendInviteAction` rotates the token + pushes the 7-day expiry out and re-emails (old forwarded links die — freshest link wins); `revokeInviteAction` hard-deletes the token so its link stops working. Both surface a copyable fallback URL when email delivery fails, matching the invite modal.
- [x] **X8 · 🟠 [FEAT] No soft-delete / deactivate for team members.** ✔ `removeUserAction` no longer hard-deletes — it now stamps the Tier 3 `User.deletedAt` sentinel (no new schema needed). The member loses access immediately (auth + queries already filter `deletedAt: null`) but their tasks/expenses/activity survive, so the confirm copy ("their contributions stay in the records") is finally true. New **Deactivated** panel on `/team` restores them via `reactivateUserAction` (clears the sentinel, re-notifies) until the 90-day purge cron fires. Deactivation also re-points company ownership away from a tombstoned owner and invalidates their pending invites.
- [x] **X9 · 🟠 [BUG] Role change doesn't invalidate active sessions.** ✔ SHIPPED (commit `fb9f2a1`). The `jwt` callback in `lib/auth.ts:70-82` re-reads the live user row every request and refreshes `token.role`/`token.companyId`, so a role change takes effect immediately — no bump needed. Separately, `User.sessionVersion` (schema.prisma:65) + `sessionTokenStillValid()` (`lib/auth/session-version.ts`) kill a session outright when the user is tombstoned or the version is bumped (`bumpSessionVersion`, used by password reset at `lib/actions/password-reset.ts:153`). Smoke: `scripts/smoke-session-invalidation.mjs`. ~~DEFERRED — needs a session-version claim.~~
- [x] **X10 · 🟠 [BUG] Notification links don't verify target still exists.** ✔ `deleteTaskAction` now sweeps `Notification.deleteMany({ link contains taskId=<id> })` inside the same transaction as the task delete, so the "New task assigned" notification never points at a phantom row. Project + transaction delete-side follow the same pattern in a future pass.
- [x] **X11 · 🟠 [UI] Notification bell badge is a 2×2 dot.** ✔ Shipped in N6 — now a proper numeric badge with `9+` overflow.
- [x] **X12 · 🟠 [UI] Running-entry only in topbar** — not surfaced on `/time` header. ✔ New `RunningEntryBanner` at the top of /time when the current user has an active session — shows started-at, task title (or "Untagged work"), note, and a live duration in the same font weight the topbar widget uses.
- [~] **X13 · 🟠 [UI] Inconsistent mark-all-read affordance** across dropdown vs page. NOT A REAL INCONSISTENCY — dropdown uses a compact text link (right-context), full page uses a pill button (broad-context). Both say "Mark all read" and route to the same action. Deliberate density difference.
- [~] **X14 · 🟡 [UI] Empty state art reuses generic Bell icon everywhere.** FALSE POSITIVE — surveyed all nine `EmptyState` call sites: each already uses a context-appropriate icon (Target/budgets, TrendingDown/expenses, Wallet/investments, Briefcase/projects, CheckSquare/tasks, Clock/time, Repeat/recurring, Activity/activities). Bell appears only on notifications, where it belongs.
- [x] **X15 · 🟡 [BUG] Activity feed has no dedupe.** ✔ Read-side dedupe shipped 2026-07-04: consecutive events with identical type + message + actor within a 5-minute window collapse into one row with a ×N badge. Presentation-only — DB audit trail stays complete.
- [x] **X17 · 🟠 [BUG] The purge cron does not know chat exists.** `Message` became the seventh soft-delete table when chat landed (2026-09-24), and `app/api/cron/purge-soft-deleted/route.ts` has not caught up. Three separate gaps, found while building the chat schema: ✔ Fixed 2026-09-26. `purgeCompany` now deletes `MessageReaction` → `Message` → `ChannelMember` → `Channel` by name, in dependency order, before the tables that would have cascaded them, and `softDeleteWorkspace` tombstones `Message`. Severity was narrower than filed: every chat FK to User/Company/Channel is `onDelete: Cascade`, so the transaction never jammed — the rows went, but the returned count omitted them, which means the DRY-RUN (the default mode) under-reported and the >100-row Sentry canary under-counted. `tests/lib/db/purge-invariants.test.ts` PARSES `prisma/schema.prisma` for every model carrying `deletedAt` and asserts each is swept or explicitly excluded — so the eighth soft-delete table is covered the day it lands, rather than being noticed at 3am.
  1. **The bulk-mutation canary goes blind on the biggest deletion in the system.** Chat rows vanish through DB-level `CASCADE`s that Prisma never counts, so `workspaceRowsDeleted` undercounts by the entire chat volume — a workspace with 50k messages reports a few hundred rows and `warnBulkMutation` stays silent. Fix: explicit stages before `tx.user.deleteMany` — `messageReaction` → `message` → `channelMember` → `channel` — so the counts are real and the ordering is stated rather than inherited from Postgres. It will NOT jam today (every chat FK is `Cascade` except `Message.parentId`, which is `SetNull`); this is about observability, not breakage.
  2. **No scope ever purges a tombstoned message.** The cron has two scopes — whole Company and empty Project — so a message deleted in a live workspace keeps its `body` forever. Either add a sweep or state the exclusion in the header prose, the way it already does for the individual-user gap.
  3. **If it does sweep, two things bite.** Purging a reply leaves `Message.replyCount` stale on the surviving root (it renders "5 replies" over 3), so the sweep must decrement the parent. And purging a thread ROOT `SET NULL`s its replies' `parentId`, promoting orphaned replies to top-level timeline rows — the right call versus cascading a whole conversation away, but it is user-visible and the cron should be where that is decided deliberately.
  → [app/api/cron/purge-soft-deleted/route.ts](app/api/cron/purge-soft-deleted/route.ts)
- [ ] **X16 · 🔵 [OPP] Weekly digest email, quiet-hours for notifications, Slack integration for mentions, iCal export, presence indicator.**

## 6. Settings · i18n · a11y · Mobile · PWA

- [x] **S1 · 🔴 [BUG] Manifest missing `/icon.svg` file** — shipped in P0-2.
- [x] **S2 · 🔴 [FEAT] No danger zone.** ✔ Shipped `deleteAccountAction` + `deleteWorkspaceAction` (see [lib/actions/account.ts](lib/actions/account.ts)) with password re-auth on both, and a workspace-name-match confirm on delete-workspace. Sole-user "delete account" cascades to workspace delete; multi-user path only tombstones the leaving user so the workspace history survives. **Since Tier 3 landed 2026-07-03 both actions are SOFT deletes** — the row stays with a `deletedAt` sentinel for 90 days, then the nightly purge cron hard-deletes it. Recovery within the window is one SQL `UPDATE` per table.
- [x] **S3 · 🟠 [FEAT] No change-email flow with verification.** ✔ Shipped. `requestEmailChangeAction` (session-scoped, rate-limited) checks the target isn't taken, then emails a 1-hour HMAC token (`purpose: "email-change"`, carries the new address) **to the new inbox** — proving ownership before any swap, so a typo can't lock you out. `/verify-email-change` applies it on click via `confirmEmailChangeAction` (works logged-out on any device, idempotent on double-click, re-checks collisions in the window) and lands the address verified. Profile edit is now name-only; the email row shows read-only with a dedicated **Change email** button in settings.
- [ ] **S4 · 🟠 [FEAT] No MFA/2FA setup.** Deferred — Auth.js supports TOTP with a follow-up integration commit.
- [~] **S5 · 🟠 [FEAT] No system-theme option.** DEFERRED — three-way theme choice ("system") means widening the store type + a `matchMedia("prefers-color-scheme")` listener. Follow-up.
- [x] **S6 · 🟠 [FEAT] Locale + theme not synced to DB.** ✔ Added `User.theme` + `User.locale` columns (migration `20260704152626_add_user_appearance_prefs`). The settings appearance/language controls now call `updateAppearanceAction` on change (fire-and-forget) so the choice is durable, and a `PreferenceHydrator` mounted in the app shell seeds the client store from the DB once per session — localStorage stays the instant-paint cache, the DB is authoritative across devices. Coerces defensively so a legacy/bad value falls back to the app defaults.
- [ ] **S7 · 🟠 [FEAT] No timezone preference.** DEFERRED (evaluated 2026-07-04). The column is trivial; the cost is that **every date render** (`formatDate`, `format(...)`, `formatDistanceToNow`, the reports month buckets, the weekly timesheet, CSV/PDF exports) currently uses the browser's local zone — honouring a stored tz means threading it through all of them (or a `date-fns-tz` rollout). That's a cross-cutting change best verified against a running app in multiple zones, not done blind alongside the rest of this batch. `User.timezone` + a settings picker is the easy 20%; the formatter rollout is the 80%.
- [~] **S8 · 🟠 [FEAT] No profile photo upload; no company logo.** EXCLUDED by the user (2026-07-04) — avatars are initials-based and adding image upload means object storage + per-workspace blob growth they don't want to pay for. Same storage dependency as the excluded F3 (receipts). Revisit only if a storage bucket for user assets is provisioned.
- [x] **S9 · 🟠 [FEAT] No email/in-app notification-preferences UI.** DEFERRED (evaluated 2026-07-04). A real preferences matrix has to be *enforced*, not decorative — that means gating the notification fan-out at all **10 creation sites** (each with different recipient logic: all-company for transactions, single-user for task-assigned, project-scoped for budgets) behind per-user category/channel prefs, ideally by first centralising fan-out through one helper. The X4 `category` column is the foundation this builds on. It's a genuine refactor + schema pass on its own; a read-side-only mute would be a fake feature (still stores + counts the rows), so it's deferred rather than faked. ✔ Shipped as Phase C, verified 2026-09-26. `lib/notify/fan-out.ts` is the single enforced write path: a direct-`notification.create` sweep over `lib/` and `app/` returns ZERO hits outside that module, and `tests/lib/notify/fan-out-sites.test.ts` keeps it that way by reading the directories rather than a hardcoded file list. `NotificationPreference` + `components/settings/notification-matrix.tsx` give the 7×3 matrix, and the deferral's own condition — "enforced, not decorative" — is met at the fan-out, not the read side. One deliberate divergence from the original plan: the end-of-day mention digest was NOT built. `lib/email/quota.ts` (a 300/day budget that degrades to in-app + push when spent) protects the same thing the digest protected — Gmail's ~500/day cap taking password resets down with it — and bounds every event rather than only mentions. Mentions still email one-per-mention until the budget runs out. Recorded as S22 so the substitution is visible rather than buried here.
- [x] **S10 · 🟠 [FEAT] No "Export my data" (GDPR).** ✔ Shipped `GET /api/export` (admin-only, rate-limited) — streams the full workspace as JSON: company, users (passwordHash stripped), transactions, tasks, budgets, projects, time entries, activities, comments, recurring rules. Invite-token secrets are stripped. Settings exposes a **Download my data** button. Adversarial review found + fixed 4 issues before merge.
- [~] **S11 · 🟠 [FEAT] No PWA install button; no offline write queue.** ✔ (install button) Added an **Install app** section in settings backed by `InstallAppButton`, which captures the `beforeinstallprompt` event and triggers the native install prompt, reports "installed" when running standalone / after `appinstalled`, and shows an iOS "Add to Home Screen" hint where the event never fires. i18n en + ur. The **offline write queue** half (IndexedDB + background sync) remains deferred — it's a much larger reliability feature (conflict handling, replay) than the install affordance and warrants its own pass. The service worker already provides offline *read* caching.
- [x] **S12 · 🟠 [BUG] Hardcoded English strings escape i18n.** ✔ `change-password-modal.tsx` now threads `showLabel`/`hideLabel` from `t.auth.show/hidePassword` into the `PasswordField` subcomponent. `confirm-dialog.tsx` falls back to `t.common.cancel`/`t.common.confirm` instead of raw English.
- [x] **S13 · 🟠 [BUG] No skip-to-content link.** ✔ Added a keyboard-focus-only `Skip to main content` link at the top of the root layout; `<main>` inside the app shell now carries `id="main"` so it lands somewhere useful.
- [x] **S14 · 🟠 [BUG] Toast (`react-hot-toast`) not `aria-live="assertive"`.** ✔ Toaster `ariaProps` now default to `role="status" aria-live="polite"` for info/success; error toasts explicitly upgrade to `role="alert" aria-live="assertive"`.
- [x] **S15 · 🟠 [BUG] Manifest missing PNG raster icons at 192 / 512.** ✔ SHIPPED — `public/android-chrome-192x192.png` (5.2 KB) and `public/android-chrome-512x512.png` (20 KB) exist and are both referenced from `public/manifest.json`. ~~DEFERRED — Write tool can't emit binary PNGs.~~ Follow-up: generate `public/icon-192.png` + `icon-512.png` via a build-time helper (or a manual export from the SVG) and reference them in `manifest.json`.
- [~] **S16 · 🟠 [BUG] No `apple-touch-startup-image`.** DEFERRED — same binary-file constraint as S15. Follow-up: generate the required PNGs per Apple's device-size matrix.
- [x] **S17 · 🟠 [UI] Modal sizes are `sm/md/lg/xl` only.** ✔ `<Modal>` is now a bottom-sheet on `< sm` viewports (full-width, rounded top corners) and a centered card at `sm` and up. Every existing size (sm/md/lg/xl) becomes the desktop max-width via `sm:max-w-*` variants.
- [x] **S18 · 🟠 [UI] Confirm dialog buttons + labels not localizable.** ✔ Same fix as S12 — button labels now flow through `t.common.cancel`/`t.common.confirm`.
- [~] **S19 · 🟡 [BUG] Number formatting not locale-aware** ("999 sessions" not "۹۹۹") for Urdu. Deferred — needs an `Intl.NumberFormat(t.locale)` sweep across formatters. ⚠ PREMISE WAS WRONG, corrected 2026-09-26. Verified empirically (Node 24 / ICU 77): `new Intl.NumberFormat("ur").resolvedOptions().numberingSystem === "latn"` and `.format(999) === "999"`. CLDR's default for `ur` (which resolves to `ur-PK`) is ALREADY Latin digits — only `ur-IN` defaults to `arabext`. Urdu never rendered ۹۹۹ and will not unless someone adds `ur-IN`. The prescribed "`Intl.NumberFormat(t.locale)` sweep" would have shipped a diff with zero behaviour change, and `t.locale` never existed (`useT()` returns only the dictionary). What shipped instead: `lib/i18n/numbering.ts` + `lib/format.ts`, where the numbering system is an EXPLICIT per-locale decision with a test that fails if a locale is added without making it — because the real risk was never Urdu digits, it was a future locale silently inheriting whatever CLDR felt like. Left `[~]` because currency is deliberately untouched: `formatCurrency` pins `en-US` under the F4 decision, and money people paste into bank portals is exactly where Latin digits matter most.
- [x] **S20 · 🟡 [BUG] No RTL sidebar mirror check for Urdu.** Deferred — CSS logical-property audit for the sidebar + drawer + all fixed-position elements. ✔ Fixed 2026-09-26, and the sidebar turned out to be the smaller half. `dir` WAS wired (`SUPPORTED_LOCALES` carries it, `Providers` synced it) — but in a `useEffect`, so the server rendered `<html>` with no `dir` at all and an Urdu reader got a full **LTR first paint on every page load**, then watched the shell jump. Mirroring the sidebar first would have made that flash worse, so the pre-paint bootstrap now sets `lang`/`dir` alongside the theme class. Then the shell, sidebar, topbar and chat rail moved to logical properties (`ms-`/`me-`, `start-`/`end-`, `border-s`/`border-e`, `transition-[margin-inline-start]`). Logical utilities were preferred over `rtl:` overrides deliberately: Tailwind emits `rtl:` AFTER responsive variants, so `lg:ml-64 rtl:mr-64` loses at every breakpoint and fails silently in the direction nobody tests. `tests/lib/layout/rtl.test.ts` scans the shell for physical utilities; live code is at zero. Real visual RTL verification still needs a browser and stays on the manual checklist.
- [ ] **S21 · 🔵 [OPP] Density preference, contrast-mode boost, mobile bottom-nav for primary actions, "reset all preferences".**

---

## How to work through this

Same pattern as BUGS.md worked well:
1. Batch by severity, ship as one commit per batch (P0 → P1 → P2 → P3).
2. Fix in-place, tick `[x]` with a one-line note under the row.
3. If a finding turns out to be a false positive or is deliberately deferred, mark `[~]` with the reason inline — don't just delete the row.
4. Run `npm run typecheck && npm test && npm run build` before every batch commit.
5. Update the totals block at the top of this file when the counts shift meaningfully.

---

## 7. Chat · mentions — truth sweep (2026-09-25)

Filed during the post-chat pass that went looking for places the code or the
marketing says something untrue. Both rows below are **documented, not fixed**;
each says why.

- [ ] **X18 · 🟡 [BUG] The chat migration's `#general` backfill is not idempotent, despite a comment saying it is.** `prisma/migrations/20260924100000_add_chat/migration.sql:113` argues that deriving the id (`'chgen_' || substring(md5(c."id"), 1, 20)`) instead of generating it makes the INSERT "idempotent by primary key rather than by hope". A duplicate primary key **raises** in Postgres; it does not skip. Neither backfill INSERT — `Channel` at :119, `ChannelMember` at :149 — carries `ON CONFLICT DO NOTHING`, so a re-run (a snapshot restored over a live DB, a half-applied migration resumed by hand, the same SQL replayed against a branch DB) aborts the whole transaction rather than no-op'ing. The derived id is what makes the fix *possible*; it isn't the fix. Note also that at the moment the `ChannelMember` INSERT runs, the `(channelId, userId)` unique index does not exist yet — section 4 creates it afterwards — so the only constraint a re-run can trip there is the `chmem_` primary key.
  **Deliberately not fixed in place.** That migration is applied, and Prisma stores a checksum per migration, so editing applied SQL makes every existing database report drift on the next `migrate deploy` — including production, where migrate runs at build time and a failure blocks the deploy. If we ever want the guarantee the comment claims, it is a NEW migration replaying both INSERTs with `ON CONFLICT DO NOTHING`, never an edit to this one. Low urgency, because the *runtime* path is covered independently: `lib/chat/bootstrap.ts` creates `#general` and its memberships on demand, so a workspace that the backfill missed (or that signed up after it) self-heals on first visit. This row is about the one-shot SQL and the comment that oversells it.
  **Still open 2026-09-26, and still not tickable.** Two things now reduce it to a latent hazard rather than a live one. The RUNTIME path no longer depends on that backfill at all: `lib/chat/bootstrap.ts` creates `#general` inside `signupAction`'s and `acceptInviteAction`'s transactions, looking the channel up by `{ companyId, slug }` first and catching P2002, so it is idempotent by construction. And `prisma/migrations/20260925130000_heal_missing_general_channels/migration.sql` — written to repair the workspaces created before that fix — demonstrates the pattern this row asks for, carrying `ON CONFLICT DO NOTHING` on both INSERTs and proven idempotent by running it twice against a probe workspace (0→1 channel, 0→1 member, second pass a no-op). Closing X18 itself needs a NEW migration whose only job is to re-state the old backfill safely, and nobody has decided that is worth writing for a file that only re-runs if a snapshot is restored over a live database.
  → [prisma/migrations/20260924100000_add_chat/migration.sql](prisma/migrations/20260924100000_add_chat/migration.sql)
- [x] **T16 · 🟠 [BUG] A teammate whose name is written in Urdu script cannot be @mentioned at all.** `slugifyName` (lib/comments/mentions.ts:59-65) ends with `.replace(/[^a-z0-9-]/g, "")`, so a name carrying no ASCII letters slugifies to the **empty string**. The module header already lists this at :21 under "edge cases we deliberately DON'T handle", and the unit test encodes the loss (`slugifyName("José")` → `"jos"`) — but the consequence is larger than a footnote: the product ships a full Urdu locale, so this is a user who is structurally unaddressable inside their own workspace, and nothing in the UI tells them why. Three surfaces, all verified: ✔ Fixed 2026-09-26, end to end. `User.handle` (nullable, `@@unique([companyId, handle])`) added by `20260925140000_add_user_handle`, which backfills every existing user from their email local-part and de-duplicates per company — verified against the live dev database: 5/5 users, zero nulls, zero collisions. `lib/user/handle.ts` derives and de-collides at runtime, wired into BOTH `signupAction` and `acceptInviteAction` so new accounts are not born unmentionable. `lib/comments/mentions.ts` resolves against the handle as well as the name slug, with the precedence written down so an ambiguous token cannot silently ping the wrong person. Settings exposes the handle with helper text explaining what it is for. The `\p{L}` shortcut stays rejected and the reason is in the module header: it makes `@ali` ambiguous with Urdu text following an `@`.
  1. **Never resolvable.** `extractMentions` (:82) and `tokenizeForRender` (:123) both skip empty slugs when building the lookup index, so no `@token` can ever resolve to that user and no mention notification can ever fan out to them.
  2. **Never selectable.** `findMentionQuery` only treats a token as an in-progress mention while the text after the `@` matches `/^[a-zA-Z0-9-]*$/`, so typing Urdu after an `@` dismisses the autocomplete. The candidate filter (components/mentions/use-mention-autocomplete.ts:117) does also match on the raw name, so such a teammate is visible in the list only for as long as the query is still empty.
  3. **Renders as a blank handle.** If they are picked from that momentarily-open list, `accept` (:135) inserts `` `@${slug} ` `` — literally `"@ "`. The DM picker (components/chat/new-dm-modal.tsx:169) and both suggestion lists render `@` followed by nothing.
  **Fix (plan §10): a `User.handle` column**, unique per company, defaulted from the email local-part and editable in settings. It is typable on any keyboard, it is stable when someone renames themselves, and it leaves the token grammar untouched. **The tempting shortcut is worse:** widening the regex to `\p{L}` looks like a one-line fix, but Urdu writes no ASCII word boundary the tokenizer can see, so `@ali` followed by Urdu prose greedily swallows the following words into the token — every mention inside an Urdu sentence becomes ambiguous, and the ambiguity is silent (it resolves to nobody). It would also need the `u` flag, and `Array.from` around any `matchAll` since tsconfig has no `downlevelIteration`.
  **Blast radius:** 8 runtime call sites across 5 files — lib/comments/mentions.ts (:82, :123), components/mentions/use-mention-autocomplete.ts (:117, :135), components/comments/comment-thread.tsx (:82, :263), components/chat/message-composer.tsx (:244), components/chat/new-dm-modal.tsx (:169) — every one of which assumes "the slug IS the handle". Plus: tests/lib/comments/mentions.test.ts, whose "strips non-ASCII / punctuation" case asserts the lossy behaviour and would have to be rewritten; the three write paths that must mint and de-duplicate a handle (signup, invite accept, profile edit); and a backfill migration for existing users. `lib/chat/slug.ts` deliberately does NOT reuse `slugifyName` (channel slugs are their own grammar) and is unaffected.
  → [lib/comments/mentions.ts](lib/comments/mentions.ts)


---

## 8. Post-delivery sweep (2026-09-26)

Filed after the chat/search/backlog push. The first row is the one a user hit
in the product; the rest came from hunting its *class* rather than its
instance. That class — **shipped, tested, and unreachable** — has now produced
three separate bugs in this codebase, so it gets its own section.

- [x] **X19 · 🔴 [BUG] Opening a DM failed for every seeded teammate: "Pick a teammate".** Reported from the running app. `OpenDmSchema` validated with `z.string().cuid("Pick a teammate")`, on the stated ground that "Ids are cuids (Prisma `@default(cuid())`)" — **and that premise is false**. The demo workspace's users are `demo-ahmed`, `demo-fatima`, `demo-ali`, `demo-sarah`: hyphenated, human-readable ids from `prisma/seed.ts`. Zod's cuid regex is `/^c[^\s-]{8,}$/i` — no hyphens, must start with `c` — so every teammate was rejected at the boundary **before `openDmAction` ever ran**, and the schema's own error message was toasted at the user.
  The system mints at least three id shapes and only one is a cuid: `@default(cuid())` values; the chat migration's deterministic `chgen_…`/`chmem_…` ids, which pass the cuid regex **by accident** (they happen to start with `c` and carry no hyphen); and `prisma/seed.ts`'s fixed `demo-*` ids, which do not. **Chat was the only feature in the repo using `.cuid()`** — budget, comment, project, recurring, task and time all use `z.string().min(1)`, and being the outlier is what broke it.
  ✔ Fixed 2026-09-26: all three chat id fields use a shared bounded `IdField` (trimmed, non-empty, ≤64 chars). The tests were the other half of the problem — they asserted *"rejects a userId that is not a cuid"*, so they would have stayed green while the feature was unusable. They now iterate `REAL_ID_SHAPES`, a table of the id forms the system actually mints, and assert every one is accepted. → [lib/schemas/chat.ts](lib/schemas/chat.ts), [tests/lib/schemas/chat.test.ts](tests/lib/schemas/chat.test.ts)

- [ ] **X20 · 🟠 [BUG] Nobody can delete a chat message — the action has no caller.** `deleteMessageAction` (lib/actions/chat.ts) is fully implemented: author-or-admin gate via `canDeleteMessage`, soft-delete tombstone, the lot. **Nothing in the UI invokes it.** `components/chat/message-row.tsx` renders the tombstone state for an already-deleted message but offers no affordance to create one, so Phase E's acceptance criterion — "I delete my own message and it becomes 'Message deleted'; an admin can delete anyone's; a cofounder cannot delete mine" — is unreachable in the product.
  This is the THIRD instance of one pattern, after `createChannelAction` (no create button until it was reported) and `openDmAction` (blocked by X19). A unit test proves a function is correct; nothing in this repo proves a user can reach it. The structural fix is a test that walks `lib/actions/**` for exported actions and asserts each has at least one caller outside its own module — it would have caught all three. → [lib/actions/chat.ts](lib/actions/chat.ts), [components/chat/message-row.tsx](components/chat/message-row.tsx)

- [ ] **X21 · 🟠 [BUG] `?message=` deep links go nowhere.** Both `sendMessageAction`'s mention notifications and cross-content search build hrefs of the form `/chat/<slug>?message=<id>`, but **no file under `app/(app)/chat/` or `components/chat/` reads `useSearchParams`**. So clicking a mention notification, or a chat hit in the command palette, opens the right conversation scrolled to the bottom with the target message nowhere on screen and nothing highlighted. Search's Phase H criterion — "A phrase from a chat message jumps to that message" — is not met. Contrast `?taskId=`, which IS handled.
  Implementing it must also handle a hit whose `parentId` is non-null: that message lives in a thread, so the panel has to open rather than the timeline merely scrolling. → [app/(app)/chat/[slug]/chat-client.tsx](app/(app)/chat/[slug]/chat-client.tsx), [lib/queries/search.ts](lib/queries/search.ts)

- [ ] **X22 · 🟡 [BUG] Chat search only matches whole words, and the migration claims otherwise.** `lib/queries/search.ts` uses `websearch_to_tsquery`, which emits no prefix operator, while `20260925120000_add_message_search/migration.sql` advertises the GIN index as serving "prefix matching (`to_tsquery('english','budg:*')`), which is what makes type-ahead work". Both statements are individually defensible — `websearch_to_tsquery` genuinely does not throw on half-typed input, which `to_tsquery` does — but together they are a contradiction, and the user-visible effect is that typing "budge" returns task and project hits (those are ILIKE substring matches) and zero message hits, which reads as chat search being broken. Fix is either to write the trade down in both files or to OR in a prefix arm built from a server-side tokenisation, never from raw user text. → [lib/queries/search.ts](lib/queries/search.ts)

- [ ] **X23 · 🟡 [FEAT] No way to join or leave a public channel.** `createChannelAction` is the only writer of a `ChannelMember` row outside the migration backfill and `lib/chat/bootstrap.ts`, and `markChannelReadAction` deliberately refuses to auto-join on open ("an upsert here would look harmless and do exactly that"). Public channels are readable and postable without membership by design — membership only drives the unread badge — so the consequence is narrow but real: a teammate who wants to be notified about `#growth` has no button to press, and no way to stop being notified about one they joined. → [lib/actions/chat.ts](lib/actions/chat.ts), [components/chat/channel-header.tsx](components/chat/channel-header.tsx)

- [ ] **N13 · 🟡 [BUG] The app icon is a 69KB raster pretending to be a vector.** `public/icon.svg` is an `<svg viewBox="0 0 512 512">` wrapping a single base64 `<image>`, and the embedded PNG is **256×256 stretched 2× into the 512 box** — so the shipped mark is a visible upscale, and it costs ~69KB on every page load. The generator's comment claiming "the PNG is rendered at exactly the size the `<image>` occupies, so nothing is up-scaled" was false and has been corrected in place, but the asset itself is unchanged. Raising the render to 512 roughly quadruples the payload; the real fix is a hand-authored vector — the mark is a charcoal stem around an emerald counter-form, a handful of paths, under 1KB at any size. That is a design task, not a build-script change. → [public/icon.svg](public/icon.svg), [scripts/_gen-brand-assets.mjs](scripts/_gen-brand-assets.mjs)

- [ ] **S22 · 🟡 [OPP] The mention digest was substituted, not built — recorded so the swap is visible.** Phase C's plan called for mentions to batch into an end-of-day digest cron, to keep Gmail's ~500/day free cap from being eaten by notification mail and taking password resets down with it. No digest exists. What shipped instead is `lib/email/quota.ts`: a 300/day budget that degrades notifications to in-app + push once spent. It protects the same failure and is strictly broader — it bounds *every* event rather than only mentions — but it is not the same thing, and mentions still send one email per mention until the budget runs out. A busy workspace will hit the breaker and silently stop emailing rather than batching. Decide whether the digest is still wanted now the breaker exists. → [lib/email/quota.ts](lib/email/quota.ts), [lib/notify/fan-out.ts](lib/notify/fan-out.ts)

- [ ] **X24 · 🔵 [OPP] `listChannelOptions` has no callers.** Written for the Runway card's channel picker and the command palette; the Runway card ended up posting into the channel already open, and search builds its own hrefs. Harmless dead code today — flagged only because it is the same shape as X20 and should either acquire a caller or go. → [lib/queries/chat.ts](lib/queries/chat.ts)

---

## 9. Accessibility wave (2026-09-29) — the first ten P2 rows

> Six agents over one checkout, file-disjoint. **All ten findings closed**, and
> four of them turned out to be one root cause: the semantic-token layer and
> Tailwind utility specificity in `app/globals.css`, not sixty-three call sites.
>
> **a11y-001 / a11y-002** — the global `:focus-visible` ring at globals.css:177
> was never missing; it was *outranked*. Tailwind compiles `focus:outline-none`
> to `.focus\:outline-none:focus`, specificity (0,2,0), against a bare
> `:focus-visible` at (0,1,0), so the utility won regardless of source order at
> all 74 sites — and `outline-none` is `outline: 2px solid transparent`, a live
> declaration rather than an absent one. Focus went from a 1.90:1 border tint to
> a 2px ring measured at 3.06–5.82:1 in both themes.
> **a11y-003** — the `.dark` block redefines `--danger-strong` but *not*
> `--danger`, so dark mode inherited red-600 from `:root` and every validation
> message read 2.55:1 on a card. Fixed by re-pointing Tailwind's `textColor`
> theme key (which merely defaults to `theme.colors`), so all 113 `text-*` sites
> and every variant spelling move to the `-strong` ramp while `bg-*`/`border-*`
> keep the fill ramp. `--danger-strong` itself was also wrong — 4.45:1 on a
> card, tuned against the page background — and moved to red-300.
> **a11y-004** — placeholders measured 2.25:1 worst case across 21 sites.
> **a11y-006** — `role="dialog" aria-modal="true"` on the command palette was a
> claim with no mechanism: Shift+Tab landed on an invisible full-viewport
> backdrop button, one press from leaving. Now a focus trap, `aria-hidden` +
> `inert` on every non-ancestor subtree with exact prior values restored, and
> focus returned to the opener.
> **a11y-007** — both topbar dropdowns claimed `role="menu"` while owning a
> heading, a scroll region and prose timestamps. Converted to disclosures rather
> than forced into the menu pattern, which may only own `menuitem`/`group`/
> `separator` and would have brought first-letter typeahead over notification
> prose. Keyboard-only, both panels could also be open and overlapping at once.
> **a11y-008** — the skip link resolved to nothing on ten routes; seven public
> routes gained a real `<main id="main" tabIndex={-1}>`, and `app/(app)/error.tsx`
> had its `<main>` demoted because it nested inside the shell's own.
> **a11y-009** — framer-motion's `MotionConfigContext` default is
> `reducedMotion: "never"`, so the OS preference was ignored however correct the
> CSS was; one `<MotionConfig reducedMotion="user">` fixed 6 of 8 animated
> elements (2 animate opacity only and were already compliant).
> **i18n-001** — `lang` and `dir` decoupled: `dir` follows the locale, `lang`
> follows the document's predominant language, so an overwhelmingly-English
> document is no longer tagged Urdu.
> **i18n-002** — resolved with a server-written cookie the existing pre-paint
> script reads, **not** by resolving the locale in the root layout: in Next 14.2
> that would opt the whole app out of static generation, marketing page included,
> to fix one attribute. Verified after the fact — `/` and seven other routes are
> still prerendered.
>
> Suite 1891 → **2008 tests over 143 files**; tsc clean, lint 0 errors, format
> clean, `npm run build` succeeds.

The rows below are what the wave *found* and did not fix. Three of them are the
same class the previous section is named for.

- [ ] **A25 · 🟠 [BUG] A third dropdown still claims to be a menu and is not.** `app/(app)/projects/[id]/project-detail-client.tsx` carries the identical `aria-haspopup="menu"` (:628) + `role="menu"` (:646) pair with no `role="menuitem"` child that a11y-007 just removed from the two topbar panels — so axe still reports `aria-required-children`, and the trigger still advertises arrow-key navigation and typeahead that do not exist. Deliberately not fixed in the same pass: unlike the topbar panels this one **looks like a genuine command menu** (Edit / Archive / Delete project), which is the one place implementing the real ARIA menu pattern — roving tabindex, Up/Down/Home/End, Escape — is the correct answer rather than demoting it to a disclosure. That makes it a different fix, not a fourth copy of the same one, and it deserves its own decision. → [app/(app)/projects/[id]/project-detail-client.tsx](app/(app)/projects/[id]/project-detail-client.tsx)

- [ ] **A26 · 🔵 [OPP] Fourteen of the seventeen component classes in `globals.css` have no users.** A `className` sweep of `app/` + `components/` returns zero matches for `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`, `.badge-success`, `.badge-warning`, `.badge-danger`, `.badge-info`, `.badge-default`, `.pill-mono`, `.gradient-text` and `.gradient-bg`. Only `.glass` (53), `.card` (172) and `.glass-card` (1) are live. This is **shipped, tested and unreachable in a stylesheet** — the class this file's section 8 is named for, in a form no reachability test currently looks at. `.input` and `.label` were the other two and were deleted during a11y-001, because `.input` was worse than dead weight: it encoded *both* of that wave's defects (`focus:outline-none focus:ring-primary/30` at 1.6:1 composited, and `placeholder:text-fg-muted/70` at 2.72:1), so whoever finally reached for "the shared input primitive" would have adopted the bugs. The replacement note in `globals.css` records that if that primitive is wanted it should be `components/ui/input.tsx` — a prop surface can be typechecked, and a CSS class cannot stop a call site appending `focus:outline-none` after it. The remaining twelve were left alone because several look like deliberate public API and removing them unasked in a shared tree was not that agent's call. → [app/globals.css](app/globals.css)

- [ ] **A27 · 🟠 [BUG] The brand accent fails contrast as text on light surfaces, at 262 sites.** Measured during a11y-003 with the same helper: `text-primary` is **2.54:1** on a card in light mode across **237 sites**, and `text-mint` is **1.52:1** across **25**. Both fail even the 3:1 non-text floor, so the many icon uses fail too, not just small labels. A `--primary-strong` (5.48:1 on light) already exists and the landing surface already migrated to it — the remaining sites are the app shell, which never did. The one-line mechanism is the same one that closed a11y-003: extend `textColor.primary.DEFAULT` / `textColor.mint.DEFAULT` in `tailwind.config.ts` so the text utility resolves to the `-strong` ramp while fills keep the bare token. Left out of a11y-003 because 262 sites of visible colour change is a design review, not a contrast fix. → [tailwind.config.ts](tailwind.config.ts), [app/globals.css](app/globals.css)

- [ ] **A28 · 🟡 [BUG] A failed preference fetch is never retried, so the user keeps whatever the browser guessed.** `components/layout/preference-hydrator.tsx` sets `seededForRef` **before** awaiting `getMyAppearanceAction()`, so if that call rejects or returns `{ success: false }` it is never attempted again for that user id — the account's real theme and locale never arrive for the life of the tab. Found while fixing i18n-002 and deliberately left, because the harm is bounded while localStorage or the new `ff_*` cookies hold a usable value: it degrades to "the last known preference" rather than to nothing. It becomes visible on exactly the path i18n-002 is about — a device with no stored preference, where a single failed round trip now means the whole session paints in the wrong language and direction. → [components/layout/preference-hydrator.tsx](components/layout/preference-hydrator.tsx)

- [ ] **A29 · 🟡 [OPP] The Urdu locale is 33% of the way there, and now there is a number.** i18n-001 fixed the *lie* (`lang="ur"` on an English document) but not the gap, which was measured rather than estimated: **559 user-visible English literals across 56 files** — 431 JSX text nodes, 45 toasts, 38 `aria-label`s, 29 `title`s, 16 `placeholder`s — against 282 translated dictionary keys in 7 namespaces. By "does this route's own code contain an English literal", **9 of 26 routes are covered** (the six auth screens, `/projects`, `/projects/[id]`, and `/settings` at 6 literals). The audit's own figures — "19 of 25 screens", "~364 nodes across 48 files" — were low because they counted neither attributes nor toasts and followed directories rather than the import graph. **29 literals sit in the shared shell that every one of the 17 authenticated routes pays, and `components/time/clock-widget.tsx` alone is 22 of them** — by far the highest-leverage single file. Then `/tasks` 90, `/expenses` 63, `/chat/[slug]` 54, `/revenue` and `/time` 49 each. Recommended order: the clock widget; then the 83 `aria-label`s and toasts, which are the strings a screen-reader user has no visual fallback for; then the three heaviest routes; then per-part `lang` for WCAG 3.1.2, at which point `LOCALE_TRANSLATION_STATUS.ur` flips to `"complete"` and `lang="ur"` returns on its own. Two smaller truths belong here: the skip-link label in `app/layout.tsx` is one of the 559 and cannot be translated without either resolving the locale server-side (rejected — it costs static rendering app-wide) or moving the anchor into a client component; and the settings disclosure at `strings.ts:284` says "navigation, settings, and sign-in are translated" while settings still holds 6 untranslated literals, which is marginally generous copy in two locales and therefore a product call. → [lib/i18n/strings.ts](lib/i18n/strings.ts), [components/time/clock-widget.tsx](components/time/clock-widget.tsx)

- [ ] **A30 · 🔵 [OPP] Secondary copy dips below AA on a hovered row.** `--fg-muted` against `--surface-hover` measures **4.40:1** in light and **4.37:1** in dark, just under the 4.5:1 floor — so every muted label in a list row fails while the pointer is over it and passes when it is not. Deliberately excluded from a11y-003's assertions, which cover text only against the resting surfaces (`--card`, `--surface`, `--bg`): a test that flags hover states would have gone red on tokens nobody asked to retune, and a contrast test that fails on pairs the product barely renders is one the next person deletes. Recorded so the number is not rediscovered as a finding. → [app/globals.css](app/globals.css)

---

## 10. Accessibility wave, second batch (2026-09-30) — P2 rows 11-20

> Seven agents, file-disjoint. **All ten findings closed.** Suite 2008 →
> **2103 tests over 155 files**; tsc clean, lint 0 errors, format clean,
> `npm run build` succeeds, `/` and seven routes still prerendered.
>
> **i18n-003** — the RTL guard only ever scanned `components/layout` and
> `components/chat`, so page content had never been checked: **170 physical
> direction utilities across 37 files**. 160 converted, 32 files at zero, plus
> 19 of 25 horizontal chevrons mirrored. The guard now walks `app/` and
> `components/` recursively, so a page added next month is covered the day it
> lands. One pair was deliberately **not** converted: `components/ui/modal.tsx`'s
> `left-[50%]` + `translate-x-[-50%]` is the centering idiom, and converting
> half of it puts every modal a full width off-centre in Urdu — a regression
> invisible in every locale anyone looks at. A line-level `rtl-physical-ok`
> marker records it, and a second guard fails if a marker ever stops sitting on
> a real hit.
> **resp-001** — the closed mobile drawer was only translated off-screen, so
> ~17 nav links stayed in the tab order and the accessibility tree. Now
> `max-lg:invisible`, scoped by the same variant as the transform so the two
> cannot drift; an attribute-based fix would have needed a `matchMedia` listener
> restating the breakpoint in JS, wrong for a frame on every load.
> **resp-002** — the notifications panel was wider than the viewport it hung in,
> inside an `overflow-hidden` shell, so the clipped strip could not be scrolled
> to. Fixed in the topbar, not the shell: relaxing the shell's overflow would
> have reintroduced document-level scrolling and "fixed" the panel by letting
> people scroll sideways to find their notifications.
> **resp-004** — the delete buttons on a task card and a comment were revealed
> on hover only, and were also **22×22px**, under the 24×24 minimum. Now
> revealed on focus, focus-within, `max-md` and `(hover: none)` — the last
> because a touch tablet above 768px fires no hover either.
> **resp-005** — six routes laid their skeleton out to a different width than
> their page, jumping up to 320px when data landed; `/revenue` had **no
> `loading.tsx` at all**, the one route under `app/(app)` with no Suspense
> boundary.
> **i18n-004** — dates and relative times now follow the active locale via
> `Intl`. date-fns 3.6.0 ships no `ur` locale, so there was no fix that stayed
> on date-fns. Zero hand-written Urdu: every month name and relative phrase
> comes from CLDR.
> **acct-005** — password change, account deletion and workspace deletion now
> send a security notice, deliberately outside the 300/day email budget, which
> degrades by silently dropping recipients.
> **acct-006** — the display name in the shell was stale until sign-out. Fixed
> in the jwt callback, which already re-reads the user row on every request for
> the `sessionVersion` check, so it cost two columns on a query that already ran.
> **acct-009** — a member can now export their own data, as a **per-user
> download** rather than a member-scoped workspace export: the personal path
> never calls `db.transaction`, `db.budget` or `db.recurringRule` at all, so the
> finance wall is structural rather than a filter someone can forget.
> **acct-011** — both delete confirmations said the operation could not be
> undone. It can: the rows are tombstoned and kept. The copy now states the
> 90-day window as a **floor**, which is the only form of the sentence that
> stays true whether or not `PURGE_ENABLED` is ever set.

Two of these findings were half-true as filed, and one guard was scanning a file
it should not have. Those corrections are in the commit message. The rows below
are what this batch found and did not fix.

- [ ] **A31 · 🟠 [BUG] Localised dates were the smallest third of the problem — 49 more sites still render English on an Urdu screen.** i18n-004 fixed `formatDate` / `formatRelativeTime` and all 15 of their render sites, and a guard now fails if anything reaches those helpers without a viewer locale. Three sibling patterns were measured and deliberately left, because each would move **English** output and so needs a product call rather than a sweep: **(1) `formatDistanceToNow` from date-fns at 6 render sites in 5 files** — `settings-client.tsx:274,288`, `project-detail-client.tsx:483`, `chat/thread-panel.tsx:112`, `comments/comment-thread.tsx:169`, `projects/project-card.tsx:181`. This is the identical defect wearing a different helper, and it is now *visibly* inconsistent: "Member since" renders an Urdu date directly above an English "about 2 months ago". `formatRelativeTime` is this repo's own replacement for that call, but swapping it changes English wording ("about 2 months ago" → "2 months ago"). **(2) date-fns `format(…)` at 33 render sites across 10 files** — activities, reports, tasks, time, three chat components, the task calendar, the task detail modal, the weekly timesheet. date-fns ships no `ur`, so no `{ locale }` option exists; these need the same `Intl` treatment `formatDate` received. This is the bulk of the remaining surface. **(3) bare `toLocaleString()` / `toLocaleDateString()` at 10 sites in 9 files** — these resolve to the *runtime's* default locale, which on a server is the ambient `LANG`, the exact non-determinism `formatAmountForMessage`'s docstring condemns for money. → [lib/utils.ts](lib/utils.ts), [lib/i18n/use-t.ts](lib/i18n/use-t.ts)

- [ ] **A32 · 🟠 [BUG] A soft-deleted time entry or comment still ships in the admin's workspace export.** `app/api/export/route.ts`'s `workspaceExport` does not filter `deletedAt` on `timeEntry` or `comment`, although both columns exist and `prisma/schema.prisma`'s `TimeEntry.deletedAt` comment names "the workspace export" **explicitly** as a read that must filter. So a row the product has told the customer is deleted comes back in a file they download — the same shape as the aggregate reads the 2026-07-06 hardening swept, missed because the export was not in that sweep. Found while building the per-user export (acct-009), whose own path does filter both. Scope was acct-009, so the workspace path was deliberately left alone. → [app/api/export/route.ts](app/api/export/route.ts)

- [ ] **A33 · 🟡 [BUG] The mobile drawer still has no focus trap, and the obvious fix would brick the desktop app.** With the drawer open on a phone, Tab past the last nav row walks out into the topbar behind the backdrop. `lib/hooks/use-focus-trap.ts` would supply Tab-cycling and an `inert` background for free — but it keys off a single boolean, and `mobileNavOpen` survives a resize past `lg`, where the drawer becomes the permanent rail. A trap still active there would leave the entire desktop app `inert` and `aria-hidden` with no visible way out, because the backdrop and the close button are both `lg:hidden` and only Escape would work. Closing the drawer on resize needs a viewport listener, which is a second source of truth for a breakpoint the CSS already owns — the same hazard resp-001's fix was written to avoid. Smaller than resp-001 and a genuinely separate decision; the reasoning is recorded in a comment above the focus effect in `sidebar.tsx` so the next reader does not re-open it blind. → [components/layout/sidebar.tsx](components/layout/sidebar.tsx), [lib/hooks/use-focus-trap.ts](lib/hooks/use-focus-trap.ts)

- [ ] **A34 · 🔵 [OPP] `formatUtcDate` is English-only, and two of its eleven call sites are customer-facing.** The date-only twins (`formatUtcDate` / `formatUtcMonthYear` / `formatUtcDay`, for `Transaction.date` and `Task.deadline`, stored at UTC midnight) did not get i18n-004's optional-locale treatment. The split is not clean, which is why it was left: `app/(app)/reports/reports-client.tsx` uses the **same function** for both screen and export. UI, should localise — `expenses-client.tsx:551,626` and `reports-client.tsx:433`. Export, must stay English-pinned — `reports-client.tsx:562,600,608`, whose CSV cells have to sort and re-parse. So the fix is the same optional-locale parameter plus three explicitly non-localised calls, across two files that belonged to different agents. → [lib/utils.ts](lib/utils.ts), [app/(app)/reports/reports-client.tsx](app/(app)/reports/reports-client.tsx)

- [ ] **A35 · 🔵 [OPP] Three labels on the new "Export my data" card are English literals.** `app/(app)/settings/settings-client.tsx` — `exportMine`, `exportMineDesc`, `exportMineAction` were left as literals with an `i18n debt` comment, following the `HandleSection` precedent already in that file, because `Strings = typeof en` makes an English-only key a type error and neither the agent nor I can proofread the Urdu. Part of A29's 559, listed separately only because it is new debt this batch added rather than debt it found. → [app/(app)/settings/settings-client.tsx](app/(app)/settings/settings-client.tsx), [lib/i18n/strings.ts](lib/i18n/strings.ts)

---

## 11. P2 batch 3 + batch 4A (2026-09-30) — rows 21-30 and 31-40

> 22 agents in four phases: triage, fix, adversarial verify, remediate. Shipped as
> `e651ae3`. Suite 2103 → 2256 over 165 files.
>
> **Triage first, and it changed the shape of the work.** Ten read-only agents
> checked each finding against the current code before anyone could edit. Of 13
> findings examined, **five were already closed** (auth-013, bill-015, bill-010
> as filed, bill-011's security half, acct-012's data half) and four more were
> half-closed or wrong as filed. Without that pass a wave would have spent itself
> on fixed code.
>
> **What was left was often worse than what was filed.** auth-014 was not 60
> guesses a minute but 60 **keyed by user id** — 3,600 an hour with a fresh budget
> per victim. bill-011's security half was closed and concealed a money bug:
> ambiguity was judged over tombstoned rows, so a founder who deleted their first
> workspace and kept the second had every event for the **live** one refused, and
> nobody was billed for what they were using.
>
> **Two agents refused their briefs and were right.** On auth-018 both options
> offered — wire the dead `EMAIL_VERIFICATION_REQUIRED` flag, or delete it — were
> wrong: `CODEBASE-AUDIT.md` records that the 2026-09-23 audit kept the name **on
> purpose** to avoid a dangling reference, and wiring it locks out every
> unverified paying customer on the next deploy. The boot now refuses the flag.
> bill-010's real poison message was left alone deliberately (row A38).

The rows below are what this arc found and did not close.

- [ ] **A36 · 🟠 [BUG] A customer locked out by the login throttle is told their password is wrong.** `lib/auth.ts:195-196` is `const throttle = gateLoginAttempt(...); if (!throttle.allowed) return null;` — and NextAuth turns a `null` from `authorizeCredentials` into a generic credentials error, which the login page renders as invalid email or password. **A throttled login is therefore indistinguishable from a wrong password**, so someone who has tripped `limiters.credentialsEmail` (10 failures / 15 min) is sent to reset a password that was correct all along — and the reset does not clear the throttle, so the new password appears wrong too. `loginAction` does check the limiter first and can return "Too many requests", but it only CHECKS: the consume happens inside `authorizeCredentials`, and any path that reaches the provider directly (or a check keyed differently from the consume) surfaces the generic message. Found while diagnosing a real failed sign-in during this session, not by a sweep. The fix is constrained by NextAuth's contract — `authorize` may only return a user or null — so it needs either a thrown `CredentialsSignin` subclass carrying a code the page can read, or the throttle state surfaced to `loginAction` on the same key the provider consumes. → [lib/auth.ts](lib/auth.ts), [lib/actions/auth.ts](lib/actions/auth.ts)

- [ ] **A37 · 🟠 [BUG] On production the login throttle barely throttles, and closing it needs an account first.** auth-012, confirmed open and unchanged: every limiter is a per-process `Map` on `globalThis`, so on Vercel N warm lambdas give N independent budgets and the advertised 5/min login limit is really 5×N. Two things make this a row rather than a task. **(1) It is blocked on the account owner**: a shared store means an Upstash Redis or Vercel KV instance and its credentials in the Production scope, which nothing in the repo can do. **(2) The code half is not a drop-in**, whatever the old comment promised: `consume(key): RateLimitResult` is synchronous and every Redis client is async, so it is an `await` at **more than 60 call sites across more than 20 files** (69 across 25, measured 2026-10-04). That figure is now measured and floor-checked by `tests/lib/rate-limit-shared-store.test.ts` rather than written down, because every written version of it has rotted: the banner's "~40" and this row's own earlier "48 across 22" were both under-counts within a wave, and under-stating the size of a security task is the same defect shape as over-stating a security guarantee. Doing the refactor before the instance exists would ship the defect this project keeps producing: complete, tested, reaching nothing — which the same test now refuses, by failing on any shared-store module that lands without a caller. The `User.failedLoginCount` shortcut was tried, migrated, and rejected on 2026-09-29 — a durable per-account budget is a reliable way for a stranger who knows an address to refuse its owner sign-in; the argument is at the bottom of `lib/auth/login-throttle.ts` and enforced by `tests/lib/auth/durable-login-counter.test.ts`. **Re-filed as prodready-013 on 2026-10-04 and triaged needs-owner again**, with two specifics now written into the banner because the filing proposed both: implementing the backend "behind the existing `consume()` signature so no caller changes" is not possible in either half (a synchronous method cannot make an HTTP round-trip, and an unimported backend is the unreachable defect above), and adding `UPSTASH_REDIS_REST_URL` / `_TOKEN` to `requiredProdEnv` would fail every production build over two variables no code reads — they are not provisioned either, the only copies being two empty strings in a local `.env.local` whose template slots `CODEBASE-AUDIT.md` records being removed on purpose. → [lib/rate-limit.ts](lib/rate-limit.ts)

- [ ] **A38 · 🟠 [BUG] A payment the app cannot place retries until LemonSqueezy gives up, and then there is no record of it at all.** bill-010's headline (an unparseable date poisoning the queue) was already closed — `readPeriodEnd` folds an unreadable date into `absent`, so nothing throws. The real poison message is `identity.reason === "unresolvable" && scope.enforced`, which answers 500 and deliberately writes **no** `BillingEvent` row. So an in-scope subscription the app cannot resolve — a checkout link it did not generate, therefore no `custom_data`, and a customer id matching nothing — retries until the provider stops, and the exact state the ledger was built for ("money arrived and we could not place it") is the one state that records nothing. The withholding is not an oversight: the ledger's unique index means any row is an idempotency key, so a row written here would be consumed by the retry the 500 just asked for, and the customer's upgrade would be lost the moment an operator fixed the cause. The clean fix is to let the replay branch distinguish a row written **while asking for a retry** from a genuine replay — on P2002, read the existing row and compare its outcome. That is surgery on the idempotency guard, which is why it was filed rather than guessed. → [app/api/webhooks/lemonsqueezy/route.ts](app/api/webhooks/lemonsqueezy/route.ts)

- [ ] **A39 · 🔵 [OPP] The billing ledger records whose money it was on one path and not the other.** On the payment path a `company-deleted` refusal now records the tombstoned `companyId`; on the subscription path the same refusal still records `companyId: null`, because `decideWebhookCompany`'s reject variant carries only `claimedCompanyId` and not the row it refused. Introduced knowingly while closing bill-011 and named rather than hidden. Making them symmetric means widening `WebhookIdentity`'s reject shape in the pure security module, whose resolution order **is** the security property — so it is a deliberate one-line follow-up, not a tidy-up to do in passing. No schema change. → [lib/billing/webhook-identity.ts](lib/billing/webhook-identity.ts)

- [ ] **A40 · 🟠 [BUG] The comment stripper copied into ten structural guards is defeated by a line comment containing `/*`, so those guards silently under-scan.** The two-regex shape — blank `/*…*/` first, then `//…` — runs the block pattern over text that includes line comments, so a `//` comment containing `/*` opens a block the regex closes at the next `*/`, blanking everything between. Found by an agent whose own copy had **silently blanked 130 lines and moved a parse onto an unrelated `i < 20` loop in a different section**; it replaced its copy with a string-aware scanner. Measured damage in the rest of the tree: five scanned files carry such a comment (`app/invite/[token]/page.tsx:44`, `lib/actions/team.ts:671`, `lib/auth/channel-permissions.ts:98`, `scripts/qa-auth-and-sessions.mjs:826`, `scripts/qa-security-and-tenancy.mjs:1223`), and measuring it properly — after an adversarial verifier challenged the first figure quoted here — the damage is at **one** of those sites, not two. `lib/auth/channel-permissions.ts:98` mentions `lib/queries/**`, the next `*/` is at `:115`, and the flawed stripper blanks `:98-:115`: eighteen lines, **six of them real code, and those six are `visibleChannelWhere`'s own `return { companyId, OR: [...] }`** — the channel-visibility predicate, invisible to every guard that scans that file. `lib/actions/team.ts` was named in the original row and is **not** affected: its only unpaired opener is `/invite/*` in the line comment at `:981` and there is no `*/` anywhere after it, so the lazy pattern never matches and nothing is blanked. The wrong number was reported, not measured, and propagated into two code comments before anyone checked it. Nine guards still share the flawed shape: `tests/app/loading/skeleton-width.test.ts`, `tests/app/shell/skip-link-target.test.tsx`, `tests/components/auth-forms.test.tsx`, `tests/lib/auth/durable-login-counter.test.ts`, `tests/lib/comments/mention-roster.test.ts`, `tests/lib/i18n/date-locale-reachability.test.ts`, `tests/lib/i18n/document-language.test.ts`, `tests/lib/layout/hover-reveal.test.ts`, `tests/lib/layout/rtl.test.ts`. This is the guard layer — the thing that exists to stop silent drift — drifting silently. The fix is one shared string-aware helper the nine import, not nine more private copies. → [tests/lib/layout/rtl.test.ts](tests/lib/layout/rtl.test.ts)

- [ ] **A41 · 🔵 [OPP] The throttled invite page answers HTTP 200.** auth-008's GET half is now metered (`invitePageView`, 15/min/address) and renders a refusal panel, but a Next 14 App Router page cannot set a status code — only `notFound()` and `redirect()` can, and both would state something untrue. So a human sees the right thing and a machine client cannot detect the refusal from the status line. The QA probe reads the body, so it is unaffected. Closing it means moving the meter into `middleware.ts` or a route handler, which is a larger design change than the finding asked for. → [app/invite/[token]/page.tsx](app/invite/[token]/page.tsx)

- [ ] **A42 · 🟡 [BUG] The password-reset email is sent off the response path with a 750 ms runway and no guarantee.** Closing auth-010's timing leak made the send fire-and-forget behind a uniform response floor. Two facts make that thinner than it looks: `lib/email/send.ts` caches the transport **object** but never sets `pool: true`, so every message pays a fresh TCP + TLS + AUTH handshake to `smtp.gmail.com:465` — a cold connection can exceed 750 ms, after which the response has already been sent and the reset email is dropped. A Sentry tag (`requestPasswordResetAction:send-outran-floor`) now reports when it happens, so the rate is measurable rather than assumed. The real fixes are all outside one file: `after()` needs Next 15 (this repo is on 14.2.35), `waitUntil` needs `@vercel/functions` which is not installed, and an outbox row a cron retries needs a schema change. Recorded with the measurement rather than guessed at. → [lib/actions/password-reset.ts](lib/actions/password-reset.ts), [lib/email/send.ts](lib/email/send.ts)

---

## 12. P2 batch 4B (2026-09-30) — the wave that verified itself, and A3's dashboard crash

> Nine agents: five fixes, four adversarial verifiers. **All four verdicts came
> back `holds-with-caveat`** — every core fix real and reaching a user, and 24
> caveats between them. Ten were closed in place (all in `tests/` and `scripts/`);
> the rows below are what is left.
>
> **The verifiers earned their keep twice over.** `verify:h2` and `verify:h5`
> independently found the same dead fixture — a test asserting copy the server has
> never sent — and `verify:h3` found two new exports with no consumer, one of them
> justified by a test that did not import it. Both are this repo's named defect
> classes, produced *by* fixes for other findings, in code already green and
> already reviewed by its author.
>
> **`/compact` killed two verifiers mid-run** at 04:45:55 with `[Request
> interrupted by user]`, and the first version of the progress digest reported
> them as working for thirteen minutes, because a stalled agent and a corpse look
> identical from turn counts and file mtimes. Recovered with `resumeFromRunId`:
> the five fix agents and two finished verifies replayed from cache and exactly
> two agents respawned, so no source was re-edited. The digest now reads each
> transcript for the interrupt marker and reports only the newest agent per label.
>
> **A3's dashboard crash is the most instructive failure in this audit so far.**
> `app/(app)/dashboard/page.tsx`, a Server Component, imported two plain
> constants from a `"use client"` module. React replaces **every** export of a
> client module with a client-reference proxy, so the server received `{}` rather
> than `3`; `utcMonthsAgo(now, {})` produced an Invalid Date and Prisma threw
> three layers away. To `tsc` the import is a `const 3`, so it typechecked,
> linted and unit-tested clean all the way to a paying customer. It is now
> guarded tree-wide by `tests/app/dashboard/client-boundary.test.ts` — exactly one
> violation existed. The same line had a silent second half: the cash-flow chart
> was returning zero buckets and would have rendered blank even had the page
> survived.

- [ ] **A43 · 🟠 [BUG] A member's `/settings` payload now carries the workspace's last billing charge.** `getBillingSummary` gates on `requireScopedSession()`, not the repo's own `requireFinanceSession()` — which exists for precisely this ("the server code that produces the data re-checks", `lib/queries/session.ts:28-36`). `app/(app)/settings/page.tsx:24-36` calls it unconditionally and hands the whole summary to `SettingsClient`, while the card is drawn only for `user.role === "admin"` (`settings-client.tsx:403`). So a member's RSC flight payload carries `lastCharge.amountMinor`, `currency`, `formatted` and `chargedAt` — in a file whose own header (`settings-client.tsx:11-13`) withholds `currency` from members as "finance-adjacent context". `plan`/`status`/`currentPeriodEnd` already crossed the same way and the figure is close to the public list price, so real harm is small; it is still new finance data on an ungated path, and *"members never see finance pages"* is audit-flow #1. **Queued for fix, not deferral** — recorded here because it was introduced by a fix for bill-016 and must not be lost. → [lib/queries/billing.ts](lib/queries/billing.ts), [app/(app)/settings/page.tsx](app/(app)/settings/page.tsx)

- [ ] **A44 · 🟠 [BUG] A refused invite permanently destroys the invitee's live token and tells the admin nothing happened.** `inviteUserAction` deletes the address's pending token at `lib/actions/team.ts:213-216`, **outside** the transaction, and only then opens the transaction that may refuse at `:289`. The rollback restores nothing — the delete is already committed. The ordering is pre-existing, but bill-014 **widened its reach**: a lapsed `plan="team"` workspace used to get `memberLimitForPlan → Infinity` and always succeed, and `memberLimitForCompany` now returns 2. So re-inviting an address that holds a pending invite issued under Team — never burnt, because the `subscription_expired` delivery is exactly what bill-004 says can be lost — kills that invitee's token while the admin reads "Your Solo plan is limited to 2 members." The new comment at `:261-266` claims the transaction means "no half-burnt invite token", which is the opposite of what the code does. **Queued for fix.** → [lib/actions/team.ts](lib/actions/team.ts)

- [ ] **A45 · 🟠 [BUG] A new subscriber who loses a delivery race sees no amount for a full billing period, and the declared limit does not say so.** bill-016's `notFixed` names only "a subscription whose last payment predates 2026-09-29". There is a second, permanent case: `handlePaymentEvent` resolves the workspace **only** from an existing binding (`route.ts:937-938` — "a payment event may only report on a binding we already hold, never create one"), so a `subscription_payment_success` delivered before `subscription_created` has written `billingSubscriptionId` is recorded with `outcome: "skipped"`, `reason: "unknown-subscription"` (`:1010-1017`). `lib/queries/billing.ts:198` filters `outcome: "applied"`, correctly — which excludes that first invoice forever. Not a defect in the fix; the stated limit is incomplete, and the customer affected is a brand-new paying one. → [app/api/webhooks/lemonsqueezy/route.ts](app/api/webhooks/lemonsqueezy/route.ts), [lib/queries/billing.ts](lib/queries/billing.ts)

- [ ] **A46 · 🔵 [OPP] The billing card refuses a hardcoded price and then renders a hardcoded currency, to the one audience it matters most to.** `DEFAULT_BILLING_CURRENCY = "USD"` (`lib/queries/billing.ts:70`) is a literal, used whenever `lastCharge` is null (`:218`) — which is exactly a **free** workspace deciding whether to upgrade, the moment bill-016's own test calls most valuable ("This is the moment the information is worth most: before paying"). Nothing in the repo fails if the LemonSqueezy store currency changes. That is the identical silent-staleness argument used to *reject* showing "Billed monthly" and a hardcoded price, so the two decisions disagree. `billing.ts:59-69` is honest that it is "A DEFAULT, never an override" and the cite to `lib/lemonsqueezy/config.ts:4` checks out, so the code is defensible — the inconsistency is the finding, and resolving it is a product call (read the store currency live, or accept the literal and say why in both places). → [lib/queries/billing.ts](lib/queries/billing.ts)

- [ ] **A47 · 🟡 [BUG] A fourth toast-only refusal surface, and it is the one a brand-new paying customer meets.** acct-016's wave fixed three sites and its unreachability argument was explicitly about `team-client.tsx`'s six handlers — which checks out. `app/invite/[token]/accept-invite-client.tsx:60` was outside that scope and still delivers **every** `acceptInviteAction` refusal through `toast.error(res.error || …)` and nothing else, to an unauthenticated reader with nothing else on screen. The refusals are instruction-shaped: `lib/actions/team.ts:853` "This invite has expired. Ask your admin to send a new one.", `:887` "Ask whoever invited you for a new invite.", `:926` "Try signing in instead." — and the sharpest, `:1137` **"Account created, but auto-sign-in failed. Sign in manually."**, where the account now exists and the only copy saying so expires in 3.5 seconds, leaving a password form that looks like it failed. Of everything filed from this wave, this is the one to fix next. → [app/invite/[token]/accept-invite-client.tsx](app/invite/[token]/accept-invite-client.tsx)

- [ ] **A48 · 🔵 [OPP] The three seat gates agree on the limit and disagree on the count, which strands an invite an admin already sent.** All three now ask `memberLimitForCompany` rather than the plan string — that half is exhaustive, and `verify:h2` enumerated every seat-taking path to confirm it (`user.create` at `lib/actions/auth.ts:281` and `team.ts:1032`; the one tombstone clear at `team.ts:702`). But invite counts members **plus pending invites** (`team.ts:284-287`) while reactivate counts members only (`:691-693`). So 1 member + 1 pending invite + a tombstoned teammate → Reactivate is allowed (1 < 2), and the outstanding invitee is then refused at acceptance (`:999`) and told to "ask an admin to upgrade… and send the invite again" while their token is still perfectly valid. No cap is ever exceeded and the token is not burnt (rollback), so this is copy/UX rather than an overage — but it is a new way to strand an invite, and nothing tests or documents it. → [lib/actions/team.ts](lib/actions/team.ts)

- [ ] **A49 · 🟠 [BUG] A40's sibling: the `neutralize()` scanner in three action guards is blinded by a quote inside a regex literal.** Distinct from A40's `stripComments` flaw and in different files, same consequence — a structural guard that silently stops scanning. `tests/lib/actions/{reachability,action-auth-gates,use-server-exports}.test.ts` share a character-state scanner that treats a `"` inside a **regex literal** as the start of a string and blanks everything to the next quote. Measured cost, not theoretical: while closing auth-015, `app/verify-email-change/page.tsx` briefly shape-checked an address with `[^\s<>"@]`, the rest of the file was blanked, and `reachability` reported `confirmEmailChangeAction` as an action with no caller **while the call was right there** — an hour lost. The agent worked around it in its own file (`\x22`, with a comment) rather than edit guards it did not own. The direction that matters is the other one: in `action-auth-gates` a blanked region can swallow an `export async function` declaration, so an unguarded endpoint passes. **The fix already exists in this repo**: `tests/lib/email/escape-boundary.test.ts:140-314` is a correct regex-aware implementation with fixtures pinning exactly this case. Extract it and have the three import it — and fold in A40's nine `stripComments` copies while there, since one shared scanner is the answer to both. → [tests/lib/actions/reachability.test.ts](tests/lib/actions/reachability.test.ts), [tests/lib/email/escape-boundary.test.ts](tests/lib/email/escape-boundary.test.ts)

- [ ] **A50 · 🔵 [OPP] Two small comment claims that are wrong, in a file customers' money is described in.** Both in `app/(app)/settings/settings-client.tsx`, both found by adversarial verification, neither affecting behaviour — filed together because the next reader copies them. (1) `:906` says "`Math.pow`, not `**`: tsconfig sets `lib` but no `target`, so tsc emits ES5." `tsconfig.json` sets `"noEmit": true`, so tsc emits nothing at all, and TypeScript downlevels `**` to `Math.pow` for an ES5 target without complaint — only bigint operands need es2016+. The real ES5 trap in this repo is `matchAll` / Set-spread / named capture groups, which is a different rule. (2) `:903` says "an unknown code returns null so the caller shows the currency statement with no figure attached". Measured in node: `Intl.NumberFormat` throws only for a **malformed** code — `"Q"` raises `RangeError: Invalid currency code`, while a well-formed-but-unknown `"QQQ"` resolves and formats `QQQ 10.00`, assuming two minor units. **Nothing crashes**: `formatChargeAmount` wraps the construction in `try/catch` and does return `null`, so the sentence is right about `"Q"` and wrong about `"QQQ"` — the failure mode is a figure computed on a guessed exponent, not an exception. Reachable only because `readInvoiceCharge` validates with `currency.length === 0` rather than a three-letter shape, and the code is then interpolated straight into the customer-facing sentence by `billingCurrencyNote`. Now pinned as a known boundary in `tests/lib/queries/billing-summary.test.ts`. Provider data makes it near-unreachable; the wrong reason in the comment is the filing. → [app/(app)/settings/settings-client.tsx](app/(app)/settings/settings-client.tsx)

- [ ] **A51 · 🔵 [OPP] Persistent error surfaces never clear on edit, and one copy line is now stale.** Two leftovers from the acct-016 family, both consistent with existing precedent, both raised rather than hidden. (1) `app/signup/page.tsx:108-112` (`handleContinue`) does not clear `formError`, so "that email belongs to a deleted account" can stay on screen describing an address the reader has already replaced, until the next submit — same in the invite dialog. `app/forgot-password/page.tsx` and the change-email surface behave the same way, so this is a known edge, not a regression. (2) `lib/actions/email-change.ts:142` tells the address being replaced that the change "only takes effect if the confirmation link sent to <new> is opened". After auth-015 opening is necessary but no longer sufficient — the customer confirms twice. It reads as a necessary condition so it is not false, but nobody signed off the expectation mismatch. → [app/signup/page.tsx](app/signup/page.tsx), [lib/actions/email-change.ts](lib/actions/email-change.ts)

## 13. Wave C + the chat unread badge (2026-10-01)

Seven slices partitioned by **file ownership** rather than domain, because the only
thing that actually went wrong with concurrency in batch 4B was two agents editing
one file. 74 findings examined: **62 fixed**, 22 already closed, **19 wrong as
filed**, 25 deferred. 134 files.

Every slice was verified by a second agent reading the diff against `HEAD`, and
**nine of the 54 verifier findings were defects the fixes themselves introduced** —
three of them in the guard layer, the code whose whole job is to notice:

- Closing "an expired invite must not hold a seat" silently made `resendInviteAction`
  an ungated **fourth seat gate**: free cap 2, one member, one expired invite, two
  clicks, two live invites on a cap of two. No race required.
- The A49 scanner fix put `<` in `OPERATORS_BEFORE_REGEX`, so `</Tag>` read as a
  regex start and two closing tags on one line swallowed everything between — a
  **false negative** in `reachability`, `action-auth-gates` and `use-server-exports`.
  That is the direction where an unguarded endpoint passes.
- `smoke-loading.mjs` shipped **unable to pass**: it clicks a sidebar link for all 15
  derived routes, and five finance routes render no `<a>` until the group is expanded.
- The chat deep-link broke **three of its own four outcomes** — the reader landed at
  the top of loaded history, worse than not shipping it.
- `clampSpan`'s off-by-one dropped the **newest month** from the cash-flow chart, and
  the test's `±1` tolerance was exactly the size of the bug.

### The unread badge, and chat leaving the notifications list

Reported directly: a message arriving in `#general`, a private channel or a DM
announced itself by writing a **notification row**, so chat appeared under the bell
beside budget alerts and role changes while the word "Chat" in the sidebar never
moved. The per-channel badges in the rail were correct and tested; nothing totalled
them.

`unreadChatTotal` (`lib/queries/chat.ts`) is that total, built from the **same three
rules** as `listChannelsForUser` so the nav and the rail cannot disagree: a
membership row is the gate, your own messages are never unread, archived channels
drop out. Muted channels still count, because `mutedAt` is documented as "no
notification fan-out", not "no badge", and the rail already badges them. Two queries
regardless of channel count, on a 30-second poll behind the existing
`document.hidden` gate — the same load argument as perf-004 one row down.

`notifyUsers` gained `skipInApp`, and **only the two DM fan-outs pass it.** An
@mention still writes its row: a badge counts messages and cannot say that one of
them named you, so for the one event that addresses a person the durable list is the
only surface carrying the fact. `EVENT_DELIVERABLE_CHANNELS` records which events can
still reach which channel, and `tests/lib/notify/fan-out-sites.test.ts` derives that
from the call sites — so the settings matrix cannot go on offering an "In app"
checkbox for direct messages, which would save, read back, and govern nothing.

- [ ] **A52 · 🟠 [BUG] `npm test` exited 1 for the length of this change, under a green summary.** The sidebar's new poll was mocked in `tests/components/shell-responsive.test.tsx` but never **primed**, so `unreadChatCountAction()` returned `undefined` and `.catch` threw while the `Promise.all` array was still being built. Vitest reported `13 passed` and then six unhandled `TypeError`s, and exited 1. **Fixed.** Filed anyway for the reporting failure behind it: the run was pronounced clean here on an exit code read from a `grep` at the end of a pipe, not from vitest. Both sibling sidebar tests prime the mock; this one wired it and stopped. → [tests/components/shell-responsive.test.tsx](tests/components/shell-responsive.test.tsx)

- [ ] **A53 · 🟡 [BUG] `reached` promised a delivery receipt nothing in the fan-out can produce.** The new return value counted anyone on a preference list that survived the tombstone filter — but `firePush` and `fireNotificationEmails` are both fire-and-forget behind a dynamic import, so a recipient with push enabled and **no subscribed device**, or whose mail falls outside the daily budget, counted as reached, and the composer said "pinged N" over it. Renamed **`dispatched`**, with the distinction written into the name rather than a comment: the in-app share is real (rows are written before the call returns), the other two are sends. Raised independently by two of five adversarial lenses. **Fixed.** → [lib/notify/fan-out.ts](lib/notify/fan-out.ts)

- [ ] **A54 · 🔵 [OPP] Four small consequences of the badge, recorded rather than fixed.** (1) `tests/components/sidebar-chat-badge.test.tsx`'s "rides the notification poll instead of adding a second one" asserts equal call counts, which a *second* poller on the same interval would also satisfy — the test is weaker than its name. (2) `markChannelReadAction` returns success without writing when the caller is not a member, so the badge refetches on every message in a public channel nobody joined. Wasteful, not wrong. (3) No last-write-wins guard between the 30-second poll and the post-read refetch; two in-flight answers can resolve out of order and show a stale number for one tick. (4) `unreadChatCountAction` is unmetered — which matches its sibling `unreadNotificationCountAction`, so it is a comment-accuracy point, and the real question is prodready-013 (the limiter lives on `globalThis` and does not survive more than one lambda). → [components/layout/sidebar.tsx](components/layout/sidebar.tsx), [lib/actions/chat.ts](lib/actions/chat.ts)

- [ ] **A55 · 🟠 [BUG] The new "due today" deadline bound compared a UTC day against a LOCAL one, so its one-day slack became two days every evening.** Wave C fixed tasks-and-comments-011 by comparing calendar days instead of instants — `deadlineDayValue` reads the day from UTC parts, which is `lib/tasks/deadline.ts`'s whole job. The bound beside it was built from `new Date()` and **local** getters. On every machine whose local date differs from the UTC date — most of the world for part of every day — the two sides disagreed by one: at the suite's pinned `TZ=America/Bogota`, after 19:00 local the UTC date has rolled over, and a deadline **two full days in the past was accepted**. Caught by the suite's own `rejects a deadline properly in the past`, which had been green for hours and went red from nothing but the clock moving — the fix and the test were both written before 19:00. Every other case in that file builds its fixture from `new Date()`, so which side of the boundary a run lands on was decided by the wall clock. Now one frame on both sides, plus five frozen-clock cases either side of the boundary that fail deterministically against the old bound. **Fixed.** → [lib/schemas/task.ts](lib/schemas/task.ts), [tests/lib/schemas/task.test.ts](tests/lib/schemas/task.test.ts)

> **The smoke that would have failed on correct code.** `scripts/smoke-chat-dm.mjs`
> asserted that a DM wrote a `Notification` row, on the sound reasoning that without
> the `dm` fan-out a direct message is silent. The reasoning survived; the signal
> moved. Left alone it would have gone red against a working product, which is the
> worst kind of check — the kind that teaches people to ignore the suite. It now
> asserts **both** directions: no notification row (the thing the change exists to
> stop) **and** a non-zero unread watermark (the thing that replaced it). Either one
> alone passes while the product is broken.

## 14. P2 security-and-tenancy tranche (2026-10-02) — a fixer and a tester per finding

Nine findings, worked **one at a time**: an agent fixes, a different agent tries to
break the fix and must reverse the source change and watch the test go red before it
will pass the item. 19 agents, no errors.

**Four of the nine were already closed** — each confirmed by a tester mandated to
challenge that verdict, two of which returned `no-change-needed` after trying and
failing to reproduce. The filings were written against an older tree, and the tell is
usually a line number: sec-013 cites `components/providers.tsx:80-94`, which in this
tree is the service-worker registration effect.

| finding | verdict | what it was |
|---|---|---|
| sec-009 CSP | **needs-owner** | real, and the fix is a deployment trade (below) |
| sec-012 push takeover | **fixed** | a genuine cross-tenant write |
| sec-013 localStorage role | already-closed | closed by 9150f6e, plus a new pin |
| sec-014 invite bcrypt | already-closed | the throttle landed as auth-008 |
| sec-015 password limiter | already-closed | fixed as auth-014 in e651ae3 |
| sec-016 cofounder tasks | **needs-owner** + fixed half | a permission widening, not a defect |
| sec-017 deactivated assignment | **fixed** | three-quarters closed, one quarter real |
| sec-018 reset for removed account | already-closed | fixed 2026-09-28, 8-case pin |
| sec-020 audit trail | **fixed** | three of four loci |

### What the adversarial half was worth

20 findings, 4 major, **one `broken` verdict** that sent the item back for remediation
and produced a real fix:

- **sec-016's fixer reported the impact as closed. It was closed on `/tasks` only.**
  `TaskDetailModal` declared `canEdit?: boolean` **defaulting to `true`**, and
  `project-detail-client.tsx` passed `canDelete` but no `canEdit` — so on
  `/projects/[id]` the status dropdown rendered enabled for every viewer and produced
  a bare "Not authorized" toast, which is the finding's impact sentence verbatim. The
  remediation made `canEdit` **required**, so a call site that forgets it is now a
  typecheck error rather than a silently enabled control.
- **sec-016's fixer then introduced a false comment of the class it was correcting**,
  claiming both bulk actions must express the rule in SQL. `bulkDeleteTasksAction`
  already does `findMany` then `updateMany`, so it can filter per row.
- **sec-012's "the caller learns nothing about whether that endpoint is registered"
  was false.** The message is uniform; the outcome is not — an unregistered endpoint
  takes the create path and returns success. One bit survives in the `success` flag.
- **sec-013's residue was permanent, not a flash.** A persisted row with a missing or
  non-string `email` made the lookup throw; the catch swallowed it *without*
  hydrating, so a forged `currentUser.role` governed the client store for the whole
  page lifetime. The tester proved it by appending a probe to the fixer's own test
  file, watching `expected "vi.fn()" to be called at least once` fail, then removing
  the probe and restoring the file byte-identically.

- [ ] **A56 · 🔵 [OPP] Two redundant defences, one of them untested — and the tests looked complete.** The sec-013 remediation added both a total lookup (`typeof u?.email === "string"`) and a fail-safe catch that hydrates from the session when anything above it throws. Either alone prevents the bug, so the first tests — which asserted only the outcome, "the session wins" — passed with **either one reverted**, and would have shipped an untested defence under a green suite. Caught by mutating each half separately rather than by reading. Fixed with two assertions that can tell them apart: `console.error` **not** having been called proves the lookup absorbed the row rather than the catch rescuing it, and a store that throws on access reaches the catch where the lookup guard cannot help. Both now fail alone. The general lesson is that redundant defences need assertions that discriminate between them, not assertions on the shared outcome. → [components/providers.tsx](components/providers.tsx), [tests/components/providers-session-role-authority.test.tsx](tests/components/providers-session-role-authority.test.tsx)

- [ ] **A57 · 🟠 [BUG] A flaky test in the suite that guards the clamp notice — it failed once in six consecutive runs, after 22.8 seconds.** `tests/app/reports/reports-clamp-notice.test.tsx` drives the real `ReportsClient` with `userEvent` on real timers, and that component pulls its three charts through `next/dynamic` with `ssr: false`. Mounting it therefore starts three async chunk loads that resolve into recharts, and every click races them: on a quiet machine the test finishes in about a second, under load it spent **22.8 seconds** and then failed. Both of its sibling reports tests already avoid that cost. Found by running the suite repeatedly rather than by reading it — the first failure looked like a one-off, and the same tree passed four times around it. **Fixed** by stubbing the three chart components, which changes nothing the file asserts: it is about whether a `role="status"` message renders, and the charts carry none of it. Now 3-for-3 green with test time back to ~1s. The general hazard is wider than this file: 12 test files build fixtures from `new Date()` with no frozen clock, which is the same shape of time-dependent failure as A55 — green all day, red in one window. → [tests/app/reports/reports-clamp-notice.test.tsx](tests/app/reports/reports-clamp-notice.test.tsx)

### Open for the owner

- **A nonce-based CSP makes every route dynamically rendered**, marketing page
  included, which `app/layout.tsx` itself calls "a large permanent cost". There is no
  incremental step: per CSP3, `'unsafe-inline'` is ignored the moment a nonce- or
  hash-source appears, so hashing our one bootstrap script would immediately block
  all 66 of Next's own inline flight chunks. That trap is now a test, not a comment.
  The tester argued the trade is narrower — scope the nonce to `/(app)/*`, already
  dynamic because it calls `auth()` — but could not prove it without `next build`.
- **Where CSP violations should report to.** Needs a destination that exists.
- **What a co-founder seat means.** A cofounder can create a task in any project, set
  that project's budgets, rename and archive it, and post in the task's comment
  thread — but cannot mark the task done. A prior wave declined this widening
  deliberately and wrote `tests/app/tasks/task-permissions.test.ts:59-66` so it could
  not land silently, so granting it means deleting those assertions.
- **Brute-force alerting.** `lib/auth.ts:229` already captures repeated credential
  rejections to Sentry with a user id and hash prefix. Nobody is paged on it, so the
  signal is produced and discarded. That is an alert rule, not a commit.

## 15. P2 money-correctness tranche (2026-10-02) — eight findings, none of them stale

Same method as section 14: one finding at a time, a fixer and then a different agent
whose job is to break the fix. **8 of 8 were real and fixed** — the exact inverse of
the security tranche, where 4 of 9 were already closed. The two domains had diverged
because months of hardening had overtaken the security filings while nothing had
touched the money ones. "Roughly half are stale" is not a general rate; it is
per-domain, and sizing the rest of the queue on one blended number would be wrong.

Every one of the eight testers returned `holds-with-caveat` — not one clean pass.
That is a property of the domain rather than sloppiness: a money figure appears on
several surfaces at once, so changing how one computes or displays it leaves the
others stating the old thing. Four of the caveats were exactly that.

| finding | what it was |
|---|---|
| money-016 | **half wrong as filed** — the hard delete was already soft since data-integrity-001. The real half: no way to correct a mistyped amount at all. Built `updateTransactionAction` + edit controls, 14 tests, including re-judging the budget threshold for the **old and the new** category |
| money-013 | the "empty project" gate counted tasks and budgets but not transactions, so a project carrying real spend was deletable and the purge then nulled every tag through `onDelete: SetNull` |
| money-017 | burn divided by a constant 3 regardless of history: a one-month-old workspace read **33,333 and twelve months of runway** where the truth was 100,000 and four. Both surfaces now share `lib/finance/runway.ts` |
| money-018 | the UI disabled per-project budget categories the server explicitly permits, making per-project budgeting unusable past the first project |
| money-014 | `100%` meant both "approaching the cap" and "over it" |
| money-011 | three forms asked for `(PKR)` in workspaces of any currency and answered in dollars |
| money-015 | negative amounts rendered `PKR -1,235` or `-$1,235` depending on whether CLDR has a symbol for the currency |
| money-012 | `NaN%` on the reports page when everything in the window rounds to zero |

### The remediation pass, and the defect it caught

25 tester findings (4 major) went into a second serial run of six items. All six
fixed. The one that justifies the whole arrangement:

**money-013's fix would have silently stopped the 90-day erasure stage.** The fix
kept tombstoned projects that still have transactions pointing at them — correct. But
purge scope 2 reads `take: 200` with **no `orderBy`**, so kept projects occupy slots
in that window every night, permanently. Once the kept set reached 200, or sooner
since an unordered read can return them first, scope 2 would purge nothing for any
tenant, for ever, and nothing would report that it had stopped. A retention promise
broken by data shape, in the file whose own `cron-002` comment is scarred by exactly
that. The remediation moved the guard out of the loop and into the candidate query
(`transactions: { none: {} }` plus a deterministic `orderBy`), which also removed a
per-project `count` — one query instead of N.

That finding arrived as `major` under a `holds-with-caveat` verdict. The runner only
remediated on `broken` when this tranche started; it was changed mid-run to remediate
on any major, and this is the finding that change caught.

Three more worth recording:

- **The materializer posts UNTAGGED rather than skipping.** A tombstoned project's
  recurring rule kept minting new live transactions tagged to it. The obvious fix is
  to skip the rule — which is `cron-004` again, a month missing from a founder's
  books. Losing a tag is recoverable; losing a transaction is not.
- **`money-017`'s fix made a second number worse.** With the divisor floored at one
  month, `averageMonthlyBurn` equalled month-to-date spend for a young workspace, so
  the pace figure compared a number against itself: **+107% on the 15th, +933% on the
  3rd, identical whether the workspace spent 5,000 or 5,000,000.** `ledgerStartsAt` is
  now a **required** argument to `burnPaceDeltaPct`, so the comparison cannot be
  computed without the fact that decides whether it means anything.
- **The false `Infinity` sentence existed in five copies.** The tester reported one;
  the sweep found the same claim verbatim in the schema, a query module, a component
  and two test files — every one documenting the formula that had just been deleted.

- [ ] **A58 · 🔵 [OPP] A purge countdown that will now run out and do nothing.** `listDeletedProjectsForUser` shows `daysUntilPurge` for a tombstoned project. After R1, a project whose transactions still point at it is kept **for ever**, so that countdown reaches zero and nothing happens. It errs in the customer's favour — the project stays restorable longer, and its transactions were never purged by that stage anyway — but the copy states a deadline that no longer applies to it. Same shape as the delete confirmation R4 just corrected: a sentence that was true until the behaviour under it changed. → [lib/queries/projects.ts](lib/queries/projects.ts)

### Open for the owner

- **Should deleting a project be refused when an active recurring rule points at it?**
  Not added, deliberately: the materializer no longer mints a doomed tag, so the
  delete is harmless, and the refusal would make a currently-allowed action fail with
  no UI to resolve it. The argument for it is that it fixes at the source and surfaces
  the orphaned rule to the customer rather than only in a cron response body.

## 16. P2 transactions-ledger tranche (2026-10-04) — fifteen findings, six majors, all six self-inflicted

The largest tranche so far: 15 findings, 36 agents, no errors. **11 fixed, 2 already
closed, 2 needs-owner.** Staleness came in at ~13%, between the security tranche's 44%
and the money tranche's 0% — further evidence that the rate is per-domain and that a
blended estimate would mislead.

**Every one of the six major findings was a defect the fix itself introduced**, not
something missed in existing code. Across three tranches that ratio has held: these
agents read existing code reliably and predict the consequences of their own changes
poorly, which is exactly the gap a second agent closes.

| finding | outcome |
|---|---|
| -001 silent truncation | **fixed** — partly stale, but four of seven surfaces still summed the capped array |
| -004 imported spend invisible to budgets | **fixed** — 100% of imported spend was excluded from 100% of budget tracking |
| -003 non-US CSV corruption | **fixed** — amounts already closed by money-009; dates were real |
| -008 duplicate import | **fixed** — detection in code, no migration; batch id left as an owner call |
| -009 formula injection | **fixed** — sanitised on export, not import |
| -014 wrong column picked | **fixed** — `subtotal` won the amount column because it contains "total" |
| -010 1,000-row cap | **fixed** |
| -007 wedged import dialog | **fixed** |
| -011 deactivated teammate notified | already-closed |
| -013 cofounder delete | **needs-owner**, and wrong as filed — UI and server already agree |
| -012 supervisor cannot record spend | **needs-owner** — widens who may write money |
| -016 comments on one ledger of three | **fixed** |
| -002 Revenue offers an "Import investments" template | **fixed**, one file |
| -005 hard delete | **fixed** — the hard-delete half was already closed by 36760ec |
| -006 PKR in a non-PKR workspace | already-closed, **overturned by its tester** |

### The six majors

1. **-001's fix left dead data on the wire.** `/team` still fetched and serialised the
   full ledger into a prop nothing read any more. The same fix also shipped `rowCount`,
   documented as a field that lets a caller print "showing N of M", with zero callers —
   this repo's signature defect, introduced by the fix for a finding about silent
   truncation. The remediation built the notice rather than deleting the field, and made
   the finance-reader gate table derive from the module's exports so it cannot silently
   fall behind again.
2. **-004's project tag was sticky for the whole page visit.** All three ledger clients
   render the import modal unconditionally and close it by flipping their own state, so
   React never discards it and `handleClose` is never reached on success. Import March
   tagged to Launch v2, and April silently inherits it — worse than the original bug,
   which at least failed uniformly.
3. **-008's dedupe missed the case it was built for, in the home market.** It keyed on
   the UTC day, justified by a comment about legacy rows stored at local midnight —
   which is false for every timezone east of UTC. At UTC+5 a legacy row and its
   re-import land on different UTC days. The remediation matched a stored row under
   every UTC day it could have been written for and widened the fetch to match, while
   leaving an exact-UTC-midnight row on one day so a real next-day charge still imports.
4. **-009's guard mangled ordinary accounting prose.** A description reading "-50%
   vendor credit" gained an apostrophe in the .xlsx while the PDF printed it clean —
   re-opening rep-006, which exists because two files from two adjacent buttons
   disagreeing about the same row is what an auditor notices. See A59.
5. **-013's fixer justified writing nothing on a false premise.** It claimed no test
   pinned either side; `transaction-edit.test.ts:320` is exactly that test. The real gap
   was the inverse and on the destructive path — `deleteTransactionAction`'s
   author-or-admin gate had no test at all, because every fixture in
   `soft-delete.test.ts` is an admin acting on their own row. Now pinned.
6. **-006's "already closed" was overturned by its tester.** The filing's headline
   symptom still reproduced: `useCurrency()` is called with no argument and falls back
   to PKR, so the server-rendered HTML of every finance page reads "Amount (PKR)" for a
   non-PKR workspace until hydration lands. The remediation threaded the currency from
   all three RSC pages instead of making the fallback smarter.

> **The best single piece of work in the tranche was a test nobody asked for.** -006's
> fixer found the finding already closed, noticed that nothing pinned the server-side
> half, wrote five tests, and then **proved they had teeth by reintroducing the exact
> hardcoded PKR the filing describes** — 4 of 5 failed — before restoring the file
> byte-for-byte with an md5 check. A test written against already-correct code is the
> easiest kind to get wrong, because it passes immediately and nothing tells you it
> would have passed anyway.

- [x] **A59 · 🟠 [BUG] The spreadsheet formula guard is a cost with no current benefit, and it was accepted on a premise nobody executed.** transactions-ledger-009 prefixes any description, author or company name leading with `=`, `+`, `-`, `@`, TAB or CR with an apostrophe on the .xlsx path. SheetJS writes that apostrophe literally, so a description reading "-50% vendor credit" renders mangled in Excel while the PDF prints it clean. **Measured, not reasoned:** `XLSX.utils.aoa_to_sheet` writes `=1+1` as `t:"s"` with no `f` attribute, and it survives a real write/read round trip as a string — so the .xlsx is **already safe** and the prefix buys nothing today. The fixer, its tester and the remediation all engaged seriously with this, and all three reasoned about SheetJS's behaviour from the finding's description of it; one `node -e` inverted the conclusion in seconds. Keep `lib/reports/spreadsheet-safe.ts` and its tests — they are correct for the genuine CSV export that does not exist yet — stop applying the marker on the .xlsx path, and pin the safety property with a round-trip test so the suite goes red if SheetJS or the export format ever changes.  ✔ **Fixed.** Re-measured first, and the measurement held: `aoa_to_sheet([["=1+1"]])` gives `t: "s"` with no `f`, it survives a real `XLSX.write`/`XLSX.read` round trip, and the emitted sheet XML is `<c r="A1" t="str"><v>=1+1</v></c>` with no `<f>` element anywhere — an OOXML cell without `<f>` has nothing to evaluate. The marker is off the .xlsx path (the import and all four `aoa_to_sheet` wrappers in `reports-client.tsx`), so rep-006 is strict equality again and `-50% vendor credit` reaches Excel as the customer typed it; the fidelity test now carries `-`- and `+`-leading fixtures so the carve-out cannot creep back by luck of the fixture set. `lib/reports/spreadsheet-safe.ts` is KEPT, uncalled, for the CSV export that does not exist yet, with its own unit tests at `tests/lib/reports/spreadsheet-safe.test.ts`. `export-formula-injection.test.ts` is now the pin: the round trip and the emitted XML, plus the two things that measurement depends on — that the export keeps writing `.xlsx` (SheetJS picks its writer from the extension, and a `.csv` IS evaluated) and keeps building sheets with `aoa_to_sheet`. Both pins were proven to bite by breaking the code under them and restoring it under md5. → [lib/reports/spreadsheet-safe.ts](lib/reports/spreadsheet-safe.ts)

- [ ] **A60 · 🔵 [OPP] /reports still sums a truncated ledger, and it is the surface that travels furthest.** Raised by -001's tester and deliberately left open by its remediation, which agreed rather than claiming the finding closed. `summaryFigures` computes Investments / Revenue / Expenses / Net flow with `sumOfType` over the capped per-type array; the category and contributor breakdowns do the same; the Excel and PDF exporters map over it. The other six consumers now either aggregate in SQL or show a truncation notice — /reports got neither. Fixing it needs a server round trip per period window, which is why it was scoped out, not because it is not real. This is the page a customer exports and sends to investors. → [app/(app)/reports/reports-client.tsx](app/(app)/reports/reports-client.tsx)

### Open for the owner — three questions that are really one

Three findings across two tranches ask the same thing in different clothes, and
answering them separately would leave a permission model explicable only as history:

- **sec-016** — may a cofounder close a task they did not file?
- **-013** — may a cofounder edit or delete a ledger row they did not create?
- **-012** — may a project supervisor record spend against the project they run?

The first two are "does a cofounder have authority over other people's records". The
third is "does a delegated role get write access to the thing it is accountable for" —
today the supervisor escape hatch is read-only in practice, so every project expense
funnels back through a founder, which is the bottleneck the role exists to remove.

Also open: whether to spend a migration on `Transaction.importBatchId` so a bad import
can be undone as a unit. The SQL is in -008's report; detection is closed without it.
