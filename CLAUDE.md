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
| `AUTH_URL` | The canonical origin, same origin as `NEXT_PUBLIC_APP_URL` | Auth.js's own origin — session cookie, sign-in redirect, `callbackUrl` | **added 2026-10-04 (prodready-023)**: with it unset, `trustHost: true` in `auth.config.ts` let next-auth take its origin from the request's `Host`/`X-Forwarded-Host`, so every hostname serving the deploy minted and accepted its own sessions |
| `CRON_SECRET` | Shared secret for the cron routes | all three `app/api/cron/*` | **all three nightly jobs 500 forever, silently** |
| `NEXT_PUBLIC_APP_URL` | Public origin, e.g. `https://…vercel.app` | invite + password-reset links | every emailed link points at localhost |
| `GMAIL_USER` | Sending address | `lib/email/send.ts` | reset emails silently never send |
| `GMAIL_APP_PASSWORD` | Gmail app password | `lib/email/send.ts` | same |

`NEXT_PUBLIC_APP_URL` is additionally value-checked: a loopback host
(`localhost`, `127.x`, `0.0.0.0`, `[::1]`) is rejected on a production build,
because a syntactically present but wrong value produced the same broken emails
as a missing one. `AUTH_URL` is value-checked the same way, plus `https` only
(@auth/core decides `useSecureCookies` from that protocol), plus a cross-check
that its **origin equals `NEXT_PUBLIC_APP_URL`'s** — two canonical domains in
one deploy means a reset link lands on a host that cannot complete the sign-in
it was sent for. Only the ORIGIN is compared, because next-auth reads
`AUTH_URL`'s path as its `basePath` — and since this app's handler lives at
`app/api/auth/[...nextauth]`, the only path that works here is `/api/auth`. That
constraint is **checked, not just written down** (added 2026-10-04 after review):
the gate accepts the bare origin and `/api/auth` (trailing slash either way) and
refuses every other path, because `https://…/app` passes a presence check, sets
`basePath=/app`, and 404s sign-in, the callback and the session endpoint alike.
Prefer the bare origin and let the default apply.

**Owner action, before the next production build:** set `AUTH_URL` in the Vercel
Production scope to the same origin as `NEXT_PUBLIC_APP_URL`. It became required
on 2026-10-04, so until it is there the next production build fails by design —
which is the intended behaviour, not a regression.

**What a pinned `AUTH_URL` does NOT close.** Auth.js sets the session cookie with
no `Domain` attribute, so the cookie is host-only on whatever hostname actually
served the response. A sign-in driven directly at an alias — a preview URL *or* a
production deployment's own `*.vercel.app` alias — therefore still stores a valid
session cookie on that alias. The pin stops the flow *settling* there (next-auth
rewrites the request's origin, so the post-sign-in redirect lands on the
canonical domain, where the visitor is anonymous and the alias cookie is
orphaned), but reducing the set of origins that can hold a live session to
exactly one needs a redirect from non-canonical hosts to the canonical one in
middleware. Not implemented — it is the remaining half of prodready-023.

Two vars are the inverse — a production build **refuses to proceed if either is
set**. `FORBIDDEN_PROD_ENV` in `scripts/vercel-build.mjs` is the list, and it is
two entries long, not one:

| Var | Refused at | What setting it switches off |
|---|---|---|
| `RATE_LIMIT_DISABLED` | any **truthy** value — `true`, `1`, `yes`, `on` | every limiter in `lib/rate-limit.ts`, including the login throttle added to close a P0 brute-force hole. `false` still deploys: that spelling is documented, and refusing it would make the documented "off" switch undeployable. |
| `PASSWORD_RESET_RESPONSE_FLOOR_MS` | **any value at all, `0` included** | the uniform response latency on `/forgot-password` (`lib/actions/password-reset.ts`). Every outcome of a reset request is held to the same response time, so the *clock* stops answering the question the response body no longer does — whether that address is registered. `0` reopens that enumeration oracle outright; a smaller number narrows it. |

Neither has any runtime signal of any kind, which is the whole argument for
catching them at build time rather than logging a warning somewhere. The floor is
also why the entries carry a `refuse` mode (`"truthy"` vs `"any"`): **its
dangerous value is `0`**, which a truthiness check waves straight through. It
exists only so two unit tests can switch the floor back ON — the action ignores
it outside vitest — so there is no value it should ever hold in a Production
scope.

**Sentry is the one member of this family that only warns** — except when it is
half-configured. Neither `SENTRY_DSN` (server, `sentry.server.config.ts`) nor
`NEXT_PUBLIC_SENTRY_DSN` (browser, `sentry.client.config.ts`) is required: no
Sentry at all is a choice this project has actually made, and a build that
refuses to ship because an observability tool is unconfigured is its own kind of
outage. So both absent → a loud warning on every production build and nothing
more. **Exactly one of the two set → the build FAILS.** A deploy that reports
server errors, drops every browser crash, and still tells the customer "The team
has been notified" misrepresents itself, and nobody goes looking for a gap that
looks healthy.

The upload trio `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` is a third
rule, and it is enforced in `next.config.js`, not in the build script — three
outcomes, not two:

- **all three absent** → `vercel-build.mjs` warns (only if a DSN is set) and the
  build proceeds. But `withSentryConfig` is applied **only** when `SENTRY_DSN`
  **and** all three are present, and that wrapper is what bundles the SDK at all
  — so this state reports *nothing*, rather than merely losing readable stack
  traces. That is today's state in production.
- **some but not all three** → `next.config.js:106` **throws**, so `next build`
  fails outright. Not a warning.
- **all three plus `SENTRY_DSN`** → source maps upload and the SDK is bundled.

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

- **Soft delete** on User, Company, Project, Task, Budget, Transaction,
  Message (chat, added 2026-09-24), Comment and TimeEntry. A
  nullable `deletedAt` timestamp on each. Auth + every scoped query
  filter `deletedAt: null`. `deleteAccountAction` and
  `deleteWorkspaceAction` write the sentinel instead of hard-deleting;
  recovery within the retention window is one SQL UPDATE per table.

  **The runbook printed here was itself a cross-tenant write until 2026-09-30,
  and it is the third place that was true (data-integrity-005).** It said to
  reunite child rows by the tombstone timestamp *alone*, within a ±1s window.
  `softDeleteWorkspace` stamps one `now` across every table in one transaction —
  so two customers who delete inside the same second share that stamp, and
  following these steps for one of them un-deleted the other's transactions into
  a workspace whose `Company` row stays tombstoned: live rows, invisible to every
  scoped query, in someone else's ledger. Only the `Company` and `User` lines
  were ever scoped.

  **Every line needs BOTH the tenant and the instant.** The timestamp stays —
  dropping it and restoring by `companyId` alone would resurrect rows that were
  individually deleted earlier (a message someone removed on purpose), which is a
  different kind of wrong. And it is `=` the exact stamp, not a range: one
  transaction wrote one value, so a window only widens the blast radius.

  ```sql
  -- Read the exact stamp first; every UPDATE below uses this value verbatim.
  SELECT "deletedAt" FROM "Company" WHERE id = '<companyId>';

  UPDATE "Company" SET "deletedAt" = NULL WHERE id = '<companyId>';
  UPDATE "User" SET "deletedAt" = NULL WHERE "companyId" = '<companyId>';
  -- …and one of these per child table: Project, Task, Budget, Transaction,
  -- Comment, TimeEntry, Message. TENANT AND INSTANT, never one alone:
  UPDATE "Transaction" SET "deletedAt" = NULL
    WHERE "companyId" = '<companyId>' AND "deletedAt" = '<exact t>';
  ```

  `tests/lib/db/restore-runbook.test.ts` parses every copy of this runbook —
  here and in `lib/actions/account.ts` — and fails on any restore statement that
  filters by timestamp without a `companyId` clause. It has no exemption for this
  file, so the version above cannot silently regress.

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

### Liveness: `/api/health` — landed 2026-10-04

`app/api/health/route.ts` is the only endpoint in this app that answers without
a session, a `CRON_SECRET` bearer or a provider HMAC. Until it existed there was
nothing an uptime monitor could poll, and the outages this app is most exposed
to — a half-applied migration, a Supabase pooler with no free connections, a
database password rotated in Supabase but not in Vercel — all leave the app
SERVING while every data-bearing page throws. Detection was "a paying customer
notices" (prodready-018).

- It runs one `SELECT 1` and answers `{ ok, db, commit, ms, checkedAt }`:
  **200** on a successful round-trip, **503** on failure or on its own 2.5s
  timeout. The timeout is the point — the usual failure is a HANG, not a throw.
- **No error detail, ever.** Prisma's P1001 quotes the host and port it could
  not reach, so echoing it from an unauthenticated route would publish the
  production database hostname. The commit SHA (`VERCEL_GIT_COMMIT_SHA`) is the
  one build detail that goes out.
- It is memoised for 5s and deduplicated while in flight, so however hard the
  URL is hit it costs at most one round-trip per window per instance. That is
  instead of a rate limiter: every limiter in `lib/rate-limit.ts` is keyed per
  IP, and a 429 at a monitor is recorded as an outage.
- Reachability is **two layers**, per the convention below: `pathname ===
  "/api/health"` is in `authorized()`'s public list in `auth.config.ts`. Without
  that line the middleware matcher answers a 302 to `/login`, which a monitor
  records as "up" — a health endpoint that is accidentally private is worse than
  none. Pinned by `tests/app/health/health-route.test.ts`, which drives the real
  allow-list and reads the matcher out of `middleware.ts`.
- `robots.txt` already disallows `/api/`, which covers it; the response also
  carries `X-Robots-Tag: noindex`.

**Left for a human, and NOT done:** nothing polls this URL. The route makes
detection possible, it does not perform it — point an external uptime monitor
(or Vercel's own check) at `https://<prod-origin>/api/health`, alert on a
non-200, and the repo side needs no further edit. Until that is configured the
mean time to detection is unchanged.

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
