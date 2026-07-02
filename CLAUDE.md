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

### What's still deferred (Tier 3 — recovery layer)

- Soft delete on User, Company, Project, Task, Budget, Transaction.
  Hard delete becomes `update({ deletedAt: now })`. A nightly cron purges
  rows older than 90 days. Anything destroyed in the last quarter is one
  SQL update from coming back.
- Nightly `pg_dump` to an R2/S3 bucket (free-tier-friendly cron + storage).
- Sentry alerts on any single mutation that touches >100 rows.

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
