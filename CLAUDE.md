# FounderFlow — operating notes

## Database safety (READ THIS BEFORE WRITING ANY DESTRUCTIVE COMMAND)

**Tier 2 landed 2026-07-02, but only halfway — corrected 2026-09-25.**
Local dev runs against a docker-compose Postgres on `127.0.0.1:5433`, which
`.env.local` names and Next.js reads first.

**The root `.env` no longer holds any value at all — emptied 2026-09-26, and
now enforced by a test.** Read the history before trusting that sentence,
because this file has claimed it before and been wrong: Prisma does not read
`.env.local` at all (that is a Next.js convention), so for months the Prisma
CLI and every bare `new PrismaClient()` resolved the PRODUCTION connection
string out of `.env` while this file said they did not.

What is different this time is that the claim is checked, not remembered:
`tests/lib/env/no-prod-credentials.test.ts` fails if any `.env*` file other
than a `*.example` template gains a `supabase.co(m)` host, a postgres password
on a non-loopback host, or — in `.env` specifically — any assigned value at
all. Local dev lost nothing when the values went: `.env.local` already supplied
a local value for all seven names (`DATABASE_URL`, `DIRECT_URL`, `AUTH_SECRET`,
`RATE_LIMIT_DISABLED`, `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `CRON_SECRET`)
and Next.js reads `.env.local` first, so those were the effective values
anyway. The prod copies in `.env` armed the Prisma CLI and nothing else. A bare
`npx prisma` now fails closed with `Environment variable not found:
DATABASE_URL`.

What that meant in practice, until 2026-09-25: `npm run db:reset:local` ran
`prisma migrate reset --force` against production and would have dropped the
live schema without a prompt. `node scripts/wipe-data.mjs` ran unscoped
`deleteMany()` across every table against production. Six smoke scripts read
and wrote production from a laptop.

**How it is guarded now — structurally, not by remembering:**

- `scripts/_local-db.mjs` owns the one rule. `localDatabaseUrl()` reads
  `.env.local` and **throws on any non-loopback host**. There is deliberately
  no fallback to `process.env`.
- `scripts/db-local.mjs` wraps every **local** `db:*` npm script, injecting the
  local URL into the child process. This Prisma version has no `--env-file`
  flag, so a wrapper is the only way to keep the CLI off `.env`.

  **This paragraph used to claim it wrapped "every `db:*` npm script". That was
  false, and false about a safety mechanism — the same shape of error as the
  `.env`-no-longer-points-at-production claim above.** `db:migrate:staging` was
  a bare `prisma migrate deploy`, so it resolved the root `.env` and applied
  migrations **directly to production**, from a command named after an
  environment that has never existed. Corrected 2026-09-26:
  `scripts/db-staging.mjs` + `scripts/_staging-db.mjs` now guard it, and
  `tests/lib/db/staging-guard.test.ts` fails if any data-touching `db:*` script
  goes unwrapped again — so the claim is now enforced rather than asserted.
- Every script under `scripts/` that touches data imports `localDb()`. A bare
  `new PrismaClient()` in `scripts/` is a bug; there are none left.

**Still open: rotation.** The credentials are off the disk, but the ones that
were there are still live — a copy taken before 2026-09-26 would still work.
`SECRET-ROTATION.md` is the step-by-step for the Supabase database password,
`AUTH_SECRET`, `CRON_SECRET` and the Sentry DSN, including the point worth
repeating here: **rotating any of them destroys no database rows.** Rotating
`AUTH_SECRET` signs everyone out once and they log back in; that is the entire
user-visible cost. This is not closed until the rotation is done.

The seed guard from Tier 1 still exists as a belt-and-braces
backup, but note what it does NOT cover: it guards the *seed*, and
`migrate reset` drops the schema before the seed is ever reached.

### Local development from scratch

```bash
docker compose up -d              # postgres on 127.0.0.1:5433
cp .env.local.example .env.local  # never commit — gitignored
npm run db:migrate:local          # applies every migration
npm run db:seed:local              # loads the demo workspace
npm run dev                       # Next.js reads .env.local first
```

### Everyday commands

| Command | What it does |
|---|---|
| `npm run db:up` | Starts the local Postgres container. |
| `npm run db:down` | Stops it. Data volume survives. |
| `npm run db:nuke` | Stops + wipes the volume. Full teardown. |
| `npm run db:migrate:local` | `prisma migrate dev` against local. |
| `npm run db:seed:local` | Reseeds the `demo-nimbus` workspace. |
| `npm run db:reset:local` | Drops schema + reruns migrations + seed. |
| `npm run db:migrate:staging` | `prisma migrate deploy` against **staging**, via `scripts/db-staging.mjs`. Exits **78** ("not provisioned") and runs nothing if there is no `.env.staging` and no `STAGING_*` secrets — which is the state today. |

### Staging — designed, never provisioned (as of 2026-09-26)

`.env.staging.example` has carried the runbook, and the instruction *"CI should
run migrations against staging on every merge to main"*, since it was written.
Nobody carried it out. There is no `founderflow-staging` Supabase project, no
`.env.staging`, and until today no CI step. **Every migration this app has ever
run has had production as its first environment.**

What now exists on the repo side, so that provisioning it is a dashboard task
and nothing else:

- `scripts/_staging-db.mjs` — the decision, pure and unit-tested. Requires
  `.env.staging` to exist, to declare `FF_ENV="staging"`, to contain no leftover
  `<placeholder>`, and to name no host the root `.env` also names (so pasting
  the production string in fails even with the declaration set). **No fallback
  to `.env`, ever** — a fallback is the hazard this replaces.
- `scripts/db-staging.mjs` — the wrapper. In CI it reads `STAGING_DATABASE_URL`
  / `STAGING_DIRECT_URL` instead of the file, and never the ambient
  `DATABASE_URL`, so the job cannot inherit production.
- `.github/workflows/ci.yml` job `staging-migrate` — runs on merge to `main`,
  and **skips cleanly with a GitHub notice while staging does not exist** rather
  than failing every merge until someone provisions it. It starts working the
  moment both secrets are added, with no further edit.
- `tests/lib/db/staging-guard.test.ts` — 13 cases over the real decision
  function, plus a structural sweep asserting no data-touching `db:*` script is
  unwrapped and that the exemption list cannot grow silently.

**Left for a human** (cannot be done from the repo): create the second Supabase
project per `.env.staging.example`, add the two repo secrets, and give staging
its **own** `AUTH_SECRET` — a shared secret means a stolen staging JWT is valid
in production.

### Environment layout

| Env | DB | Where creds live |
|---|---|---|
| **Local dev** | docker-compose Postgres 16 (127.0.0.1:5433) | `.env.local` (gitignored) |
| **Staging** | **DOES NOT EXIST YET** — intended: distinct Supabase project (`founderflow-staging`) | `.env.staging` (gitignored) locally; `STAGING_DATABASE_URL` / `STAGING_DIRECT_URL` repo secrets in CI |
| **Production** | Live Supabase (`founderflow`) | Vercel Production env vars only |

Production credentials never land in a local file. They did until 2026-09-26 —
the root `.env` held the live Supabase URL, the password in cleartext in a
comment, an `AUTH_SECRET` and a `CRON_SECRET` — and that file is now
deliberately value-free, with a test that keeps it that way. `.env` survives
only as a signpost, because deleting it invites someone to recreate it.

**Do not put a value in `.env`, not even a "temporary" one.** It is the file
Prisma loads by default, so a value there is the value a stray
`npx prisma migrate reset` connects to and drops. Local values go in
`.env.local`; production values go in Vercel's env-var UI and nowhere else.
Rotation of what was exposed is still outstanding — see `SECRET-ROTATION.md`.

If you need to inspect prod data, do it through Supabase's dashboard, not
through a Prisma client pointed at the pooler URL.

### Production migrations run at BUILD time

**Landed 2026-07-03** after an outage where two schema-changing commits
shipped to Vercel without their migrations being applied to production
Supabase. Every RSC that touched the affected tables errored until someone
ran `prisma migrate deploy` by hand.

The fix: `vercel.json`'s `buildCommand` now points at
`scripts/vercel-build.mjs`, which runs `prisma migrate deploy` before
`next build` **on production Vercel builds only**. If the migration fails,
the build fails and Vercel keeps serving the previous deployment. Preview
builds skip the migrate step (they don't have their own DB yet).

**Vercel env vars this depends on** (Production scope). **Updated 2026-09-26 —
a production build now FAILS if any of these is missing.** The list was two
entries long until then, which is exactly how three separate misconfigurations
shipped green and failed silently at runtime (audit rows prodready-002/003/004,
and prodready-005):

| Var | What it points at | Used by | If missing, before the guard |
|---|---|---|---|
| `DATABASE_URL` | Pooler URL, port 6543 (`?pgbouncer=true`) | Runtime queries | every query fails |
| `DIRECT_URL` | Session pooler / direct connection, port 5432 | `prisma migrate deploy` at build | build failed (this one was already guarded) |
| `AUTH_SECRET` | Session/JWT signing key | `lib/auth.ts`, all three token modules | nobody can sign in |
| `CRON_SECRET` | Shared secret for the cron routes | all three `app/api/cron/*` | **all three nightly jobs 500 forever, silently** |
| `NEXT_PUBLIC_APP_URL` | Public origin, e.g. `https://…vercel.app` | invite + password-reset links | every emailed link points at localhost |
| `GMAIL_USER` | Sending address | `lib/email/send.ts` | reset emails silently never send |
| `GMAIL_APP_PASSWORD` | Gmail app password | `lib/email/send.ts` | same |

`NEXT_PUBLIC_APP_URL` is additionally value-checked: a loopback host
(`localhost`, `127.x`, `0.0.0.0`, `[::1]`) is rejected on a production build,
because a syntactically present but wrong value produced the same broken emails
as a missing one.

`RATE_LIMIT_DISABLED` is the inverse — a production build **refuses to proceed
if it is SET**. Nothing prevented it before, and setting it in the Production
scope switches off every limiter in `lib/rate-limit.ts`, including the login
throttle added to close a P0 brute-force hole.

If `DIRECT_URL` is missing, the build script exits with an explicit error
message (never falls back to the transaction pooler — pgbouncer doesn't
support the migration protocol). The same fail-closed posture now covers every
row above: the build fails, and Vercel keeps serving the previous deployment.
Preview builds deliberately skip these assertions — some of these legitimately
do not exist for previews, and breaking preview deploys would be a regression.

### The seed guard (`prisma/seed.ts`) — belt and braces

Even with Tier 2 pointing local dev away from prod, the seed guard stays.
It's cheap insurance if someone temporarily aims `.env.local` at Supabase
for a one-off inspection.

1. Bails unless `SEED_RESET=true`. Stops accidental `prisma migrate reset`
   from auto-firing the seed.
2. Bails if `DATABASE_URL` matches `supabase.co(m)` or `pooler.supabase`,
   unless **both** `SEED_RESET=true` AND `SEED_RESET_ALLOW_PROD=true` are set.
   Two-key launch for the prod escape hatch.
3. Every `deleteMany()` is scoped to `where: { companyId: "demo-nimbus" }`.
   Real signup workspaces live under different company ids and are
   physically out of reach even if 1 + 2 are bypassed.

### Tier 3 recovery layer — landed 2026-07-03

- **Soft delete** on User, Company, Project, Task, Budget, Transaction and
  Message (chat, added 2026-09-24). A
  nullable `deletedAt` timestamp on each. Auth + every scoped query
  filter `deletedAt: null`. `deleteAccountAction` and
  `deleteWorkspaceAction` write the sentinel instead of hard-deleting;
  recovery within the retention window is one SQL UPDATE per table:

  ```sql
  UPDATE "Company" SET "deletedAt" = NULL WHERE id = '<companyId>';
  UPDATE "User" SET "deletedAt" = NULL WHERE "companyId" = '<companyId>';
  -- repeat for Project / Task / Budget / Transaction — they share the
  -- same tombstone timestamp so a range filter reunites them:
  UPDATE "Transaction" SET "deletedAt" = NULL
    WHERE "deletedAt" BETWEEN '<t - 1s>' AND '<t + 1s>';
  ```

- **Nightly purge cron** at `/api/cron/purge-soft-deleted` runs at 03:15
  UTC. **DRY-RUN by default** (`PURGE_ENABLED` gate): it counts what *would*
  be purged and deletes nothing unless `PURGE_ENABLED=true`. Kept opt-in so
  auto-erasing customer data stays a deliberate decision — but it is now
  **safe to enable**. Two scopes only: (1) each overdue **Company** is
  deleted in explicit dependency order inside a transaction (children before
  parents), so it never trips a `Restrict` FK regardless of cascade ordering;
  (2) individually soft-deleted **empty projects** in still-live workspaces.
  There is deliberately **no individual-user purge** — a deactivated (X8)
  user in a live workspace keeps their tombstone + all content forever (only
  whole-workspace erasure removes a user's rows), which is what fixed the
  earlier cascade-data-loss / Restrict-jam bug without touching the FK graph.
  Remaining follow-up: full GDPR erasure of an individual account's PII in a
  live workspace (needs an anonymization pass, not a cascade delete).

- **Nightly pg_dump** via GitHub Actions (`.github/workflows/backup.yml`)
  at 04:15 UTC — an hour after the purge, so the snapshot reflects the
  post-purge state. Uploads to an S3-compatible bucket via awscli.
  Setup: repo Secrets → `BACKUP_DATABASE_URL`, `BACKUP_S3_BUCKET`,
  `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`,
  optional `BACKUP_S3_ENDPOINT` for R2 / other non-AWS providers.

- **Bulk-mutation canary** — `lib/safety/bulk-mutation-guard.ts` fires a
  Sentry warning tagged `boundary: bulk-mutation` whenever a single
  mutation touches more than 100 rows. Wired into workspace delete and
  the purge cron. If a bug ever wipes 10,000 rows overnight, on-call
  sees it before customers do.

- **Session invalidation — landed 2026-08 (closes the old JWT gap).** Stateless
  JWTs used to stay valid until expiry, so a tombstoned user's live tab could
  keep reading data. Each `User` now carries a `sessionVersion` (schema.prisma:65),
  baked into the token at sign-in and re-checked against the live row on every
  request in the `jwt` callback (`lib/auth.ts:76`). If the user is gone,
  tombstoned, or the version was bumped, the session dies immediately.
  `sessionTokenStillValid` in `lib/auth/session-version.ts` is the pure,
  unit-tested decision. Both password paths bump the version inline, in the
  same `UPDATE` as the new hash so the two can't land apart — reset
  (`lib/actions/password-reset.ts:153`) and, since 2026-09-23, change
  (`lib/actions/profile.ts`), which additionally calls `signOut()` itself and
  redirects to `/login`, because the bump revokes the caller's own session too.
  `bumpSessionVersion` is the standalone lever, kept for a future "log out all
  devices" control. Legacy tokens with no version field
  default to 0 and stay valid. Smoke: `scripts/smoke-session-invalidation.mjs`.

## Repo conventions

- Server actions live under `lib/actions/`, queries under `lib/queries/`,
  zod schemas under `lib/schemas/`. Permission helpers under `lib/auth/`.
- Permission gates exist in two layers: middleware (`auth.config.ts`)
  for routes, server actions for writes. Both must agree.
- Members never see finance pages (audit-flow #1 from the rebuild plan).
  Per-project supervisors get an escape hatch inside their own project.
- Migrations are tightly hand-written when they involve back-fill;
  `add_projects` is the canonical example — see its `migration.sql`.

## Verification before pushing

- `npm run typecheck`
- `npm run build` (catches stricter TS rules `tsc` misses)
- `npm test`
- Targeted puppeteer smoke under `scripts/smoke-*.mjs` for any feature
  that touches auth, finance, or projects.
