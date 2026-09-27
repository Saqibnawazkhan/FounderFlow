# FounderFlow — codebase audit

**Date:** 2026-09-23 · **Commit at audit start:** `1a19e01` · **Branch:** `main`

Full-tree audit across four dimensions (dead code, duplication, stale
documentation, unused features/dependencies), followed by the cleanup described
in [§2](#2-what-changed). Every deletion in §2 was independently re-verified
before it was made — see [§5](#5-corrections-to-the-audit-itself) for two
findings that did **not** survive verification.

**Scope:** `app/` `components/` `lib/` `scripts/` `tests/` `prisma/` + root
config. 31.6k LOC of TS/TSX across 213 files at audit start.

---

## 1. Verdict

The codebase is in unusually good shape. There was no unreachable code, no
commented-out blocks, no dead routes, and no unused Prisma models. All 13
models are queried; every heavyweight dependency (`xlsx`, `jspdf`, `recharts`,
`framer-motion`, `@dnd-kit/*`, `zustand`, `web-push`, LemonSqueezy, Radix) is
genuinely used, several via lazy `import()`.

What dead weight existed was concentrated in four places:

| Area | Finding |
|---|---|
| **Superseded read actions** | Three `list*Action` server actions replaced by RSC queries, still exported |
| **Vestigial config** | Env vars for a mail provider and a rate-limit backend that were never adopted |
| **Type-alias sprawl** | 17 `z.infer` aliases and one result envelope copy-pasted 20× |
| **Point-in-time audit docs** | Two large `.md` files, one fully closed, one badly stale |

The single most consequential finding is not dead code at all — it is the stale
root `.env`. See [§4](#4-your-decisions--answered-2026-09-23).

**Verification:** `typecheck` clean (including a strict
`--noUnusedLocals --noUnusedParameters` pass) · `336/336` tests passing ·
`npm run build` clean. The cleanup pass removed 4 tests covering a deleted
function (334 → 330); §4.3 added 6 (330 → 336). Re-run after both §4.2 and
§4.3 landed — all three green.

> ✅ **`npm run build` verified 2026-09-23.** The first post-change attempt
> failed on `ENOENT … pages-manifest.json` — a file race, not a compile error:
> a `next dev` server on `:3000` owned `.next` during concurrent landing-page
> work. Re-run once that server was down: clean build, all routes emitted.
> Note `next build` and `next dev` sharing `.next` can leave the dev server
> serving 500s afterwards; `rm -rf .next` recovers it.

---

## 2. What changed

`69 files changed, 217 insertions(+), 386 deletions(-)` — net **−169 lines**,
excluding concurrent landing-page work (see [§6](#6-concurrent-edits)).

### 2.1 Deleted files

| Path | Why |
|---|---|
| `lib/hooks/usePrefersReducedMotion.ts` | Zero importers. Superseded twice: `app/page.tsx` uses framer-motion's `useReducedMotion()`, and `modal`/`skeleton`/`split-text` defer to the global `.01ms` CSS rule in `globals.css`. |
| `scripts/check-user.mjs` | Header: *"One-off: confirm the seeded demo user exists in Supabase."* Pre-Tier-2 debugging fossil. |
| `scripts/verify-member.mjs` | Header: *"One-shot verification…"* — debugging a stale-PWA-cache issue that has since been fixed. |

Untracked/gitignored scratch also removed: `dev.db` (118 KB SQLite from the
pre-Postgres era — nothing can open it; the project is `provider =
"postgresql"`), `coverage/`, `artifacts/` (14 regenerable Puppeteer PNGs),
`founderflow-favicons/` (spent generator export — the 4 live assets verified
byte-identical to their `public/` copies by md5; the other 7 referenced
nowhere), `tsconfig.tsbuildinfo`, and a 40 KB pre-rebuild planning doc.

### 2.2 Dead code removed

**Server actions superseded by RSC queries** — all three were exported but
never called from anywhere:

- `listActivitiesAction` (`lib/actions/activities.ts`)
- `listTasksAction` (`lib/actions/tasks.ts`)
- `listCompanyUsersAction` (`lib/actions/team.ts`)

> Worth noting: `listTasksAction` and `listActivitiesAction` queried **without**
> a `deletedAt: null` filter. Had anything wired them up, they would have
> leaked tombstoned rows straight past the Tier 3 soft-delete boundary.

Removing them cascaded — two `toClient` mappers became orphaned and went too
(`lib/actions/activities.ts` shrank 63 → 30 lines; `lib/actions/team.ts` lost
its 20-line `User` mapper and a dead `User` type import).

**Unused exports** (each verified as declaration-only across the whole tree):
`AvatarGroup`, `isActiveSubscription`, `applyDecision`, `SignupStep1Schema`,
`ROLE_COLORS`, `formatDateTime`, `formatNumber` (test-only), and a dead
`export { CATEGORY_PALETTE }` re-export.

**17 dead `z.infer` type aliases** across `lib/schemas/` — `UpdateBudgetInput`,
`NewCommentInput`, `DeleteCommentInput`, `SupportedCurrency`,
`ConfirmEmailChangeInput`, `VerifyEmailInput`, `PushSubscriptionInput`,
`BulkTaskStatusInput`, `BulkTaskDeleteInput`, `ReorderTaskInput`,
`ClockInInput`, `ClockOutInput`, `HeartbeatInput`, `CreateManualEntryInput`,
`UpdateTimeEntryInput`, `ImportTransactionsInput`, `UpdateRoleInput`.

**4 unused locals/imports** that neither `tsc` nor eslint flags today, because
`noUnusedLocals` is off and the eslint rule is only `warn` — found by running
`tsc --noUnusedLocals --noUnusedParameters` explicitly.

**13 unreferenced i18n keys** × 2 locales = 26 lines. Note the near-miss:
`time` and `activity` exist in **both** the `nav` and `projects` namespaces.
The `nav.*` copies are reached dynamically via `t.nav[item.labelKey]` and are
live; only the `projects.*` copies were dead. A naive key-name deletion would
have broken the sidebar in both languages.

The removed `projects.*` cluster (`overview`/`time`/`activity`/`pickProject`)
reads as a tab-bar label set for the project detail page — a UI that was never
built (`grep -n "tab" project-detail-client.tsx` → no matches).

### 2.3 Duplication consolidated

**`ActionResult` — 20 declarations → 1.** The identical envelope
`{ success: true; data: T } | { success: false; error: string }` was
copy-pasted into all 20 files under `lib/actions/`, and `auth.ts` had drifted
into a `data`-less fork. Now `lib/actions/types.ts`, deliberately **not** a
`"use server"` module (Next.js only permits async function exports from those;
this is types-only and erases at compile time). `auth.ts`'s three void returns
were aligned to the `data: undefined` convention the other 19 modules already
used.

**Notification mapper — 2 copies → 1.** `lib/actions/notifications.ts` carried
a byte-identical copy (verified with `diff`) of the mapper in
`lib/queries/notifications.ts`. Now exported as `toClientNotification` and
imported.

### 2.4 Correctness and documentation fixes

- **Dangling cross-reference, 10 sites.** Code comments across `lib/` and
  `prisma/schema.prisma` cited *"BUGS.md P0-4"*. `P0-4` appears **zero** times
  in `BUGS.md` — it is defined at `FaultsAudit.md:79`. Repointed.
  `prisma/migrations/…money_float_to_decimal/migration.sql` was deliberately
  **left alone**: Prisma checksums applied migrations, and editing the file
  would break `prisma migrate deploy`. It is therefore the one surviving
  reference to the now-deleted `BUGS.md` — an accepted, inert cost, since a
  comment on line 1 of an already-applied migration is never read by tooling.
- **`CLAUDE.md`** — replaced the "Known gap: soft-delete does not force
  existing JWTs to invalidate … deferred as auth-infra work" paragraph. That
  shipped in `fb9f2a1`; `lib/auth.ts:76` now re-checks every request.
- **`FaultsAudit.md`** — re-ticked **F4** (multi-currency), **S15** (PNG raster
  icons) and **X9** (role-change session invalidation), all three shipped but
  still marked deferred. Corrected the summary count, which claimed "46 still
  open" when the real figure was 14.
- **`lib/schemas/company.ts`** — a comment claimed currency was "locked to
  PKR", six lines above another comment saying it is chosen at signup. Fixed.
- **Stale mail-provider comments** — four sites referenced `RESEND_API_KEY` /
  "Resend"; the app has used nodemailer + Gmail SMTP for some time.

### 2.5 Config

- Removed `@auth/prisma-adapter` — referenced nowhere, and structurally dead:
  `session: { strategy: "jwt" }` with no `adapter:` key never instantiates one.
- Removed `@types/bcryptjs` — `bcryptjs@3` ships its own types; the stub
  describes the v2 API. Verified by typechecking after removal, not assumed.
- Removed 4 never-consumed vars from `lib/env.ts`:
  `NEXT_PUBLIC_DEFAULT_CURRENCY` (currency comes from `Company.currency`),
  `RESEND_API_KEY` (wrong provider), `UPSTASH_REDIS_REST_URL` / `_TOKEN`
  (`lib/rate-limit.ts` is purely in-memory; Upstash appears only as an
  aspiration in its comments). Their slots were dropped from both env
  templates — operators were being asked to configure things nothing reads.
- **Added `PURGE_ENABLED` to both env templates.** This is the master switch
  for the destructive nightly hard-delete cron and it appeared in **no** env
  template. An operator reading only the examples would have had no idea the
  purge was silently dry-running.

### 2.6 Test coverage gap closed

Four smoke scripts covering **shipped** features were never wired into
`scripts/run-all-smoke.sh` — it was last touched 2026-07-02, and these landed
2026-08-08: `smoke-currency`, `smoke-multi-admin`, `smoke-push`,
`smoke-session-invalidation`. Added, plus `verify-ui` (asserts no horizontal
overflow ≤375px). Ordered before `smoke-rate-limit`, which must stay last
because it trips the login limiter.

---

## 3. Deliberately kept

Recording these so the next audit doesn't re-litigate them.

| Kept | Why |
|---|---|
| `lib/seed.ts` (589 lines) | **Flagged as dead by one agent; it is not.** `lib/store.ts:18` imports it relatively (`from "./seed"`) and calls `seedData()` at `:186` and `:295`. An `@/lib/seed`-only grep misses it. |
| `bumpSessionVersion` | Unused, but retained as the primitive for a future "log out all devices". Both password paths bump inline so the hash and the bump land in one atomic `UPDATE`; the helper can't preserve that. Documented in place. |
| Duplicated `CATEGORY_PALETTE` in `dashboard-client.tsx` | **Deliberate, and documented at `dashboard-client.tsx:32`.** Importing the constant from `dashboard-charts` pulls recharts (~200 KB) into the initial chunk and defeats the lazy split. Only the dead re-export was removed. |
| `EMAIL_VERIFICATION_REQUIRED` | Unimplemented, but an explicitly reserved flag that `prisma/schema.prisma:52` documents. Removing it would have created a new dangling reference. |
| `wipe-data.mjs`, `screenshot-*.mjs` | Unreferenced, but manual dev tooling, not product code. `screenshot-i18n.mjs` documents itself as *"not a smoke — just artifacts to eyeball the layout flip."* |
| `scripts/_shot-landing.mjs` | Untracked scratch tied to in-flight landing work. |
| `lib/i18n/strings.ts` en/ur mirroring | That structural duplication is the point of a translation table. |

---

## 4. Your decisions — answered 2026-09-23

You ruled on all three. Status below; 4.2 is implemented, 4.1 and 4.3 are
waiting on you with the missing facts now supplied.

### 4.1 The stale root `.env` — **rotate: no data is deleted**

*Your call: "do not rotate if it deletes any existing data on the db."*

**It doesn't.** Rotating a Supabase database password resets the role's
credential; rows, schema and backups are untouched. There is no drop, no
re-provision, no migration. The only effect is that every client still
presenting the old password is refused until its connection string is updated.

So the condition you set is satisfied — but rotation is a *coordinated* change,
not a one-click one. Everything that must move at the same time:

| Secret | Rotate where | Also update | Side effect |
|---|---|---|---|
| `DATABASE_URL` / `DIRECT_URL` | Supabase → Settings → Database → reset password | Vercel **Production** env vars (both), `BACKUP_DATABASE_URL` in repo Secrets | In-flight connections drop; Vercel redeploy picks up the new value. No data loss. |
| `AUTH_SECRET` | Generate locally (`randomBytes(32)`) | Vercel Production | **Every signed-in user is logged out** — old JWT cookies stop verifying. No data loss. |
| `CRON_SECRET` | Generate locally | Vercel Production | Purge + backup cron calls 401 until Vercel has the new value. |

One thing the audit did not surface: the file carries the database password
**in plaintext in a comment** (the URL-encoding note), so it is legible even
to someone who only skims the file — which strengthens the case for rotating
rather than just deleting. Order stays: rotate at the source → update Vercel +
repo Secrets → redeploy → verify → then delete the file. `.env.local`
(localhost, current) is untouched throughout.

### 4.2 Password change now invalidates every session — **implemented**

*Your call: "do it, the user should get logged out."*

Done, in three parts:

- `changePasswordAction` (`lib/actions/profile.ts`) bumps `sessionVersion` in
  the **same** `UPDATE` as the new hash — mirroring `resetPasswordAction`, so
  the hash and the revocation can't land apart.
- The action then calls `signOut({ redirect: false })` itself, inside the
  request that is still authenticated. This is the part the original draft was
  missing: without it the stale JWT is merely *rejected* on the next request,
  which means middleware bounces a mid-navigation user to `/login` with no
  explanation. Failure to clear the cookie is caught and reported to Sentry
  rather than surfaced — the bump already revoked the session, so the change
  genuinely succeeded.
- `change-password-modal.tsx` drops local Zustand state and hard-redirects to
  `/login` with a "Password changed — sign in again" toast
  (`settings.passwordChangedSignOut`, added for `en` and `ur`).

The note in `lib/auth/session-version.ts` describing `changePasswordAction` as
deliberately not bumping has been corrected — `bumpSessionVersion` still has no
caller, because both password paths bump inline for atomicity.

Verified: `npm run typecheck` clean, tests pass (336/336 after §4.3). Not yet exercised in a
browser — worth one manual pass (change password → expect redirect to `/login`
→ old password refused, new one works) and a check that a second logged-in
browser is kicked out on its next navigation.

### 4.3 `canSeeProject` — wired in — **implemented**

*Your call: full fix.*

**What was wrong.** `lib/auth/project-permissions.ts` exported a tested
`canSeeProject` whose JSDoc claimed to be the gate on `/projects/[id]`, while
nothing called it. The rule that actually shipped was hand-written **three**
times in `lib/queries/projects.ts` — the list, the single fetch, and the
project picker.

Behaviour was identical, so there was no live hole. The risk was structural:
the helper asked `role === "admin" || role === "cofounder"`, while all three
live gates asked `canSeeFinances(role)`. Those agree today by coincidence.
Adding a finance-capable role later (accountant, read-only auditor) is a
one-line edit to a **finance** predicate that would have silently granted that
role visibility of every project in the company.

**What changed:**

- New `canSeeAllProjects(role)` in `lib/auth/project-permissions.ts` — a
  purpose-named predicate for the "sees every project" tier. All three live
  gates now call it instead of `canSeeFinances`. `canSeeFinances` is no longer
  imported by `lib/queries/projects.ts` at all, so the two can diverge safely.
- `canSeeProject` now delegates its top clause to `canSeeAllProjects`, so the
  helper and the gates cannot drift apart.
- `getProjectForUser` — the gate behind the detail page — routes through
  `canSeeProject` instead of its hand-rolled `if`. It probes with
  `hasTaskInProject: false` first and only runs the task lookup when that
  denies, so admins and supervisors still cost exactly one query, unchanged.
- The doc-comment lie is gone; `canSeeProject` now documents where it is
  actually wired and states the monotonicity the probe depends on.

The other two gates are Prisma `where` clauses and still cannot call a
TypeScript predicate — that part of the duplication is structural and stays.
The rename is what removes its teeth.

**Test coverage** (`tests/lib/auth/project-permissions.test.ts`, +6 → 336
total):

- three cases pinning `canSeeAllProjects` per role;
- a **regression guard** asserting `canSeeAllProjects` and `canSeeFinances`
  currently agree, carrying a comment explaining that a failure is the
  *intended* signal of a deliberate divergence — update the test, don't
  re-couple the gates;
- two cases pinning the monotonicity `getProjectForUser`'s two-step probe
  relies on (granting a task can never revoke access).

Verified: `typecheck` clean, `336/336` tests pass, `npm run build` clean. Not
exercised in a browser — the gate's behaviour is unchanged for all three
existing roles, so a smoke run is optional rather than required here.

### 4.4 Found while investigating 4.3 — unscoped read in `generateMetadata`

`app/(app)/projects/[id]/page.tsx:20-23` looks up the project for the page
title with `db.project.findUnique({ where: { id: params.id } })` — **no
`companyId` scope, no `deletedAt: null`, no permission check**, while the page
body below it is correctly gated by `getProjectOverview`.

I have **not** verified whether Next.js actually emits that `<title>` when the
page calls `notFound()` — metadata and the page render in parallel, and the
404 boundary may well replace it. So this may be inert. But the query is
unscoped regardless, and the fix is a one-liner that's correct either way:
scope it to the session's `companyId` with `deletedAt: null`. Flagging rather
than fixing since it wasn't in scope — say the word.

---

## 5. Corrections to the audit itself

Two agent findings failed verification. Recorded because both were marked
CERTAIN and one was a top-ranked removal.

1. **`lib/seed.ts` is not dead.** Ranked the #1 removal ("589 dead lines,
   CERTAIN"). The grep behind it only covered the `@/lib/seed` alias and missed
   the relative `./seed` import in `lib/store.ts:18`. Deleting it would have
   broken the Zustand store's demo-data path.
2. **`FaultsAudit.md:39`'s claim that `lib/store.ts` is dead is wrong.** It has
   14 live importers.

Both are the same failure mode: concluding a module is unreferenced from a
single import-specifier shape. Any future dead-file sweep should resolve `@/*`,
relative, and dynamic `import()` forms before concluding anything.

---

## 6. Concurrent edits

Landing-page work was in flight in the editor during this audit — `app/page.tsx`
(JSON-LD + a "How it works" section) at the start, and mid-audit a CSS-only
scroll-reveal system replacing framer-motion on `/` (`app/globals.css`, new
`components/landing/{in-view,reveal,demo-button}.tsx`, and edits to eight
existing `components/landing/*` files).

**None of that is mine.** No file under `components/landing/` or `app/page.tsx`
was touched by this cleanup. The line counts in §2 exclude it. If the build or
tests fail on a landing file, look there first.

---

## 7. Open backlog — duplication worth consolidating

Ranked by (lines removed × copies), with the risk I'd attach to each. Nothing
here was applied: each touches many files at once, and FounderFlow's server
actions have no unit tests — the smoke suite needs a running dev server, so
these cannot be verified from a cold repo.

### High value

1. **Server-action auth preamble — 52 sites across 20 files (~130 lines).**
   Three textual variants of "get session, null-check, rate-limit, finance
   gate". A `requireActor()` helper in `lib/auth/` collapses each to two lines.
   **This would also fix a latent bug:** 18 of the sites check only *one* of
   `session.user.id` / `session.user.companyId`; a helper returning both is
   strictly the safer superset. Generalize the existing `requireAdmin()` in
   `lib/actions/team.ts` into it. *Risk: low, but wide.*

2. **Actor re-fetch — 23 sites (~46 lines + 23 DB round-trips per mutation
   path).** Every one is `db.user.findUnique(...)` → `"User no longer exists"`,
   existing solely to read `user.name` for an activity message. The session
   already carries `name` (`lib/auth.ts:145`). Folding `name` into
   `requireActor()` removes the lines *and* a query from every mutation.
   *Risk: low. Measurable perf win.*

3. **Three near-identical ledger pages (~250 lines).** `expenses-client.tsx`,
   `investments-client.tsx`, `revenue-client.tsx` share ~120-140 substantive
   lines each: the filter `useMemo`, the delete-confirm handler, the search +
   category bar, the desktop table, the mobile card list. *Risk: medium* — each
   page has bespoke KPI tiles and one unique panel, and expenses alone carries
   comment threads. Extract only `<TransactionTable>` and
   `<TransactionFilterBar>` first; leave the headers per-page.

4. **Modal form scaffolding (~150 lines).** Four local `Field` components (two
   byte-identical), five `inputClass()` definitions, the same label class
   string 24× across 12 files, the cancel-button class 13×, the submit-button
   class 11×. The copies have already drifted (`transition-colors` on some,
   `appearance-none` on others) — that drift is a visual-consistency bug the
   extraction fixes. *Risk: low; pure presentation.*

### Smaller, all low risk

5. **`revalidatePath` fan-out** — 4 clusters, ~35 lines. Fixes a real
   inconsistency: `tasks.ts:278` and `:467` omit the `/projects/${id}`
   revalidation that `:200` and `:376` include.
6. **Company-scope re-check — 25 sites.** **Read the messages before
   consolidating:** some return `"Not found"`, others `"Not authorized"`. The
   latter leaks existence (it proves the id exists in another workspace).
   Consolidating on the non-leaking message is a security improvement.
7. **UTC month-window — 4 copies.** The `/budgets` progress bar and the
   threshold-alert check *must* agree on the window; today that's guaranteed
   only by copy-paste discipline, and a comment in `lib/queries/budgets.ts`
   says so.
8. **Member project-visibility `OR` clause — 2 copies** (`lib/queries/projects.ts:83`
   and `:246`). Security-relevant, and the file header already claims it's
   encoded once.
9. **Chart theme — 3 files.** `TOOLTIP_STYLE` identical ×3, colour constants,
   grid and axis prop sets ×4. **Constraint:** any shared module must not be
   imported at top level by `dashboard-client.tsx` — see §3.
10. **Remaining `toClient` mappers.** `tasks` and `transactions` still have two
    copies each, but the `lib/queries/` versions return `TaskWithCount` /
    `TransactionWithCount`. Consolidating changes the declared return type of
    the busiest mutation paths — worth doing, but behind a smoke run.
11. **Zod field fragments** — money amount ×6, description ×4, email ×5, name
    ×3, token ×3. `lib/schemas/project.ts` already does this correctly
    (`NameField`, `DescriptionField`, …) and is the model to copy.
12. **`ROLE_LABELS` reimplemented 7×** despite the canonical export at
    `lib/types.ts:176` — including a verbatim copy in
    `investments-client.tsx:31` and five inline ternaries.

### Explicitly not worth touching

`loading.tsx` files (already factored through `components/ui/skeleton.tsx`),
RSC page shells (idiomatic Next.js routing boilerplate), and the
`if (!res.success) { toast.error(...); return; }` idiom — 46 sites, but the
success path differs every time, so a wrapper costs more in indirection than it
saves. *Its* extractable half is the modal submit wrapper
(`setSubmitting → action → toast → onSaved`), identical in 6 modals.

---

## 8. Other findings not acted on

- **`/revenue` has no `loading.tsx`** while all 13 sibling routes do. The route
  blocks on a three-query `Promise.all` with no skeleton.
- **`app/(app)/time/time-client.tsx:467`** hardcodes the English literal
  `"· edited"`. The `projects.edited` translation key existed but was never
  wired up — Urdu users see English. (The unused key was removed; the
  hardcoded literal remains.)
- **Hardcoded `PKR` labels** survive multi-currency in
  `budgets-client.tsx:396`, `recurring-client.tsx:427`,
  `transaction-form.tsx:92`, and server-side in `lib/actions/transactions.ts`
  (`" PKR"` appended to activity messages at three sites). `useCurrency()` is
  already used for the *values* on those same screens.
- **`reports-charts.tsx:71`** uses `Math.abs(v)` in its tick formatter while
  its three sibling copies don't — negative values render unabbreviated.
- **`PushSubscription.userAgent`** is written on every subscribe and never
  read. Vestige of a device-management screen that was never built.
- **Schema comment drift:** `Transaction.type` and `RecurringRule.type` are
  commented `// "expense" | "investment"`, but `lib/schemas/transaction.ts`
  admits a third value, `"income"` — which is what `/revenue` filters on.
- **Raw date formatting** bypasses `lib/utils.ts` at 7 sites
  (`toLocaleDateString()`), rendering in browser locale while the rest of the
  app uses a fixed `"MMM dd, yyyy"`.
- **There is still no `README.md`.** Noted in the original 2026-05 plan; never
  written.
- **9 schemas wired into production have no tests** — `BulkTaskStatusSchema`,
  `BulkTaskDeleteSchema`, `ReorderTaskSchema`, `ClockInSchema`,
  `ClockOutSchema`, `HeartbeatSchema`, `UpdateTimeEntrySchema`,
  `PushSubscriptionSchema`, `ImportTransactionsSchema`.

### Recommended guardrail

Turn on `noUnusedLocals` + `noUnusedParameters` in `tsconfig.json`, or promote
`@typescript-eslint/no-unused-vars` from `warn` to `error`. The four unused
symbols in §2.2 passed CI for months because neither is enabled.

---

## 9. Documentation changes

| File | Action |
|---|---|
| `CLAUDE.md` | **Kept.** The only load-bearing doc — 6 live inbound references. Patched one stale paragraph (§2.4). |
| `FaultsAudit.md` | **Kept.** 14 genuinely open backlog items with useful deferral rationale. This is the repo's real TODO list. Corrected 3 rows and the count. |
| `BUGS.md` | **Deleted.** All 26 findings closed — `grep -c '^- \[ \]'` → 0, and its own header says *"21 fixed across 3 commits."* Last touched 2026-05-26. It tracked nothing. The 10 code comments that cited it were repointed to `FaultsAudit.md` first; content remains in git history. |
| `FEATURES.md` | **Deleted.** Zero inbound references anywhere. Self-described "living map", last synced 2026-07-01, ~15 commits of product behind: missing `/revenue`, billing, push notifications, and the third cron. Critically, its §11 still instructed that local `.env` points at **production Supabase** and told the reader to build Tier 2 "first" — directly contradicting `CLAUDE.md` on destructive DB commands. A doc that is both unreferenced and actively wrong about database safety is worse than no doc. |
| `analyze-this-…mochi.md` | **Deleted.** Untracked, gitignored by an `analyze-this-*.md` rule, zero references, 40 KB describing the localStorage prototype that the current app replaced. |
