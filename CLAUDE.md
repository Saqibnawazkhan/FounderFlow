# FounderFlow — operating notes

## Database safety (READ THIS BEFORE WRITING ANY DESTRUCTIVE COMMAND)

The local `.env` `DATABASE_URL` points at the **production Supabase**.
There is currently no separate dev/staging database — running
`prisma db seed` or `prisma migrate reset` here writes against live customer data.

A past incident wiped a real signup's account because the seed script
fired against this URL with no guard. The seed now refuses to run unless
you explicitly opt in. **Don't paper over the guard. Don't add a workflow
that bypasses it.** If you genuinely need to reseed, follow the runbook below.

### Safe commands

- `npm run db:seed:local` — wraps `prisma db seed` with `SEED_RESET=true`.
  Refuses if the connection URL looks like Supabase (production).
- `npm run db:reset:local` — same env, plus `prisma migrate reset --force`.
  Wipes the whole local schema. Refuses against production.

### What the guard does (`prisma/seed.ts`)

1. Bails unless `SEED_RESET=true`. Stops accidental `prisma migrate reset`
   from auto-firing the seed.
2. Bails if `DATABASE_URL` matches `supabase.co(m)` or `pooler.supabase`,
   unless **both** `SEED_RESET=true` AND `SEED_RESET_ALLOW_PROD=true` are set.
   Two-key launch for the prod escape hatch.
3. Every `deleteMany()` is scoped to `where: { companyId: "demo-nimbus" }`.
   Real signup workspaces live under different company ids and are
   physically out of reach even if 1 + 2 are bypassed.

### Not-yet-shipped roadmap (Tier 2 / Tier 3)

If you (Claude, future you, or anyone else) finds yourself reaching for
the seed against production, that's the cue to actually do this work
instead of bypassing the guard:

**Tier 2 — environment separation**

- Local Postgres via docker compose for day-to-day dev (`DATABASE_URL`
  in `.env.local` points there).
- Separate Supabase project for staging; CI uses that.
- Production stays where it is. No agent has prod creds in `.env`.

**Tier 3 — recovery layer**

- Soft delete on User, Company, Project, Task, Budget, Transaction.
  Hard delete becomes `update({ deletedAt: now })`. A nightly cron purges
  rows older than 90 days. Anything destroyed in the last quarter is one
  SQL update from coming back.
- Nightly `pg_dump` to an R2/S3 bucket (free-tier-friendly cron + storage).
- Sentry alerts on any single mutation that touches >100 rows.

If you're about to do something destructive and any of those would have
mitigated the consequences, build the mitigation **first**.

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
