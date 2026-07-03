# FounderFlow — operating notes

## Database safety (READ THIS BEFORE WRITING ANY DESTRUCTIVE COMMAND)

**Tier 2 has landed as of 2026-07-02.** Local dev runs against a docker-
compose Postgres on `127.0.0.1:5433`. `.env` no longer points at production.
The seed guard from Tier 1 still exists as a belt-and-braces backup.

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
| `npm run db:migrate:staging` | `prisma migrate deploy` — CI-only path. |

### Environment layout

| Env | DB | Where creds live |
|---|---|---|
| **Local dev** | docker-compose Postgres 16 (127.0.0.1:5433) | `.env.local` (gitignored) |
| **Staging** | Distinct Supabase project (`founderflow-staging`) | Vercel Preview env vars |
| **Production** | Live Supabase (`founderflow`) | Vercel Production env vars only |

Production credentials **never** land in a local file. If you need to
inspect prod data, do it through Supabase's dashboard, not through a
Prisma client pointed at the pooler URL.

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

**Vercel env vars this depends on** (Production scope):

| Var | What it points at | Used by |
|---|---|---|
| `DATABASE_URL` | Pooler URL, port 6543 (`?pgbouncer=true`) | Runtime queries |
| `DIRECT_URL` | Session pooler / direct connection, port 5432 | `prisma migrate deploy` at build |

If `DIRECT_URL` is missing, the build script exits with an explicit error
message (never falls back to the transaction pooler — pgbouncer doesn't
support the migration protocol).

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

- **Soft delete** on User, Company, Project, Task, Budget, Transaction. A
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
  UTC. Hard-deletes rows whose `deletedAt` is past the 90-day window.
  Companies purge first (their cascade takes children with them);
  orphaned per-row tombstones follow.

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

Known gap: soft-delete does not force existing JWTs to invalidate. A
tombstoned user's session cookie stays valid until it expires
naturally. Auth re-login is blocked immediately, and their next
navigation trips the RSC `deletedAt: null` filter and 404s, but a
live tab could keep reading stale data until the session dies. Fixing
this needs a session-version JWT claim — deferred as auth-infra work.

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
