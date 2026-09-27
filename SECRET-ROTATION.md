# Secret rotation runbook (prodready-001)

**Why you are here.** Until 2026-09-26 the repo's root `.env` held live
production values: the Supabase `DATABASE_URL` and `DIRECT_URL` (with the
database password inside them, *and* spelled out in cleartext in a comment
above them), an `AUTH_SECRET`, the live Sentry DSNs and a `CRON_SECRET`. The
file was gitignored and never entered git history, so this was never a public
leak — but it sat in plaintext on a developer laptop, inside a directory that
AI agents, editors, backup tools and crash reporters all read, and it was the
file the Prisma CLI loads by default.

The values have now been **removed from `.env`** and the file is guarded by a
test. What is left is the part only you can do: **rotating them**, so that a
copy taken before today stops working.

---

## Read this first: rotation does not delete data

The user-visible cost of everything below is *re-authentication*, not data.
Specifically:

| Rotation | Database rows affected | What a user notices |
|---|---|---|
| Supabase database password | **None. Zero rows.** | Nothing, if you update Vercel and redeploy promptly. |
| `AUTH_SECRET` | **None. Zero rows.** | Everyone is signed out once and logs back in with the same email + password. |
| `CRON_SECRET` | **None. Zero rows.** | Nothing — no user-facing surface at all. |
| Sentry DSN | **None. Zero rows.** | Nothing. |

- **Changing the Supabase database password changes a login credential, not the
  database.** Tables, rows, columns, migrations and the `deletedAt` tombstones
  are all untouched. It is the same operation as changing the password on your
  email account: the mailbox does not empty.
- **Rotating `AUTH_SECRET` invalidates session cookies, not accounts.** Sessions
  here are stateless JWTs signed with that secret (see `lib/auth.ts` and
  `sessionVersion` in `prisma/schema.prisma`). Change the secret and every
  existing cookie fails its signature check, so every signed-in user is
  bounced to `/login`. Their `User` row, password hash, workspace, projects,
  transactions and everything else are exactly as they were. They log in
  again. That is the whole blast radius.
- No rotation below runs a migration, a `DELETE`, a `deleteMany()` or the purge
  cron. Nothing here can drop a schema.

The one genuine hazard in this whole document is *forgetting to update a
consumer of a rotated value* — a stale `DATABASE_URL` in Vercel, or a stale
`BACKUP_DATABASE_URL` in GitHub Actions that turns the nightly `pg_dump` red.
Each step below names its consumers for exactly that reason.

**The old values, if you need them to compare or to roll back**, were backed up
verbatim to:

```
C:\Users\USER\AppData\Local\Temp\claude\c--Users-USER-FounderFlow\a350ed98-2437-4633-a2cf-29400c1d6a28\scratchpad\env-backup-prod.txt
```

That file is a production credential file. Delete it once rotation is done, and
do not copy it into the repo. (It lives in a session-scoped temp directory, so
treat it as short-lived.)

---

## Order of operations

Do them in this order. 1 is the urgent one — it is a database password that was
written out in cleartext. 4 is close to cosmetic.

1. Supabase database password
2. `AUTH_SECRET`
3. `CRON_SECRET`
4. Sentry DSN

Budget ~20 minutes plus one production redeploy.

---

## 1. Supabase database password (do this first)

This password appeared twice in `.env`: URL-encoded inside both connection
strings, and in cleartext in a comment explaining the encoding.

**Rotate it**

1. Supabase dashboard → your **`founderflow`** project (production) →
   **Project Settings → Database**.
2. Under **Database password**, click **Reset database password**. Let Supabase
   generate a strong one; copy it somewhere safe (a password manager, not a
   file in this repo).
3. Note the URL-encoding rule that bit us before: in a connection string,
   `@` must be written `%40`, `#` → `%23`, `/` → `%2F`, `:` → `%3A`,
   `?` → `%3F`. A generated password with punctuation will silently produce
   "authentication failed" if pasted raw. Prefer a generated
   alphanumeric-heavy password to sidestep this entirely.

**Then update every consumer** (the password is embedded in each URL):

| Consumer | Where | Which string |
|---|---|---|
| Runtime queries | Vercel → Project → **Settings → Environment Variables** → `DATABASE_URL`, **Production** scope | **Transaction pooler**, port **6543**, `?pgbouncer=true` |
| Build-time `prisma migrate deploy` | same page → `DIRECT_URL`, **Production** scope | **Session pooler / direct**, port **5432** — pgbouncer cannot speak the migration protocol |
| Nightly `pg_dump` | GitHub repo → **Settings → Secrets and variables → Actions** → `BACKUP_DATABASE_URL` | **Session pooler** shape, port **5432**, user `postgres.<project-ref>` — `.github/workflows/backup.yml` rewrites it to the transaction pooler itself, so do **not** paste the "Direct connection" string |

In Vercel, editing an environment variable does **not** affect the running
deployment. You must redeploy: **Deployments → latest production deployment →
⋯ → Redeploy**.

**Verify**

- The redeploy succeeds. `scripts/vercel-build.mjs` runs `prisma migrate deploy`
  with `DIRECT_URL` *before* `next build` on production builds, so a wrong
  password fails the build — and a failed Vercel build keeps the previous
  deployment serving. That is a safety net, not a problem: nothing goes down.
  If the build fails on the migrate step, your `DIRECT_URL` is wrong; fix it and
  redeploy.
- Load the app and sign in — that exercises `DATABASE_URL` at runtime.
- Trigger the backup workflow by hand (**Actions → Nightly database backup →
  Run workflow**) rather than waiting for 04:15 UTC. The workflow uses
  `set -euo pipefail` precisely so a broken dump fails loudly instead of
  uploading a 20-byte gzip header and showing green.

**If anything is misconfigured**, the failure mode is "cannot connect" —
requests error, data is intact, and reverting the env var to the old password
restores service until the new one is pasted correctly.

---

## 2. `AUTH_SECRET`

Signs the JWT session cookies and the JWS links in `lib/auth/*-token.ts`.

**Generate one**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# or: openssl rand -base64 32
```

Use at least 32 bytes. Do not reuse the staging or local value.

**Set it**

- Vercel → **Settings → Environment Variables** → `AUTH_SECRET`,
  **Production** scope → **Edit** → save.
- Redeploy production (env var changes need a new deployment).
- Leave `.env.local`'s local `AUTH_SECRET` alone. It is a local-only dev value
  and rotating it would just sign you out of your own dev box.

**User-visible effect — state this plainly to anyone who asks**

- **Every signed-in user is logged out once, and logs back in with their
  existing email and password. No account, workspace or row is touched.**
- Any **password-reset, email-verification or email-change link already sitting
  in someone's inbox stops working**, because those tokens are JWS blobs signed
  with `AUTH_SECRET` (`lib/auth/password-reset-token.ts`,
  `email-verification-token.ts`, `email-change-token.ts`). The user just
  requests a new link. If you want to be kind about it, rotate at a quiet hour
  rather than right after sending a batch of invites.
- Pending workspace invites are **not** affected — those are database rows keyed
  by an opaque token (`/invite/[token]`), not `AUTH_SECRET` signatures.

**Verify:** open the app in a browser that was signed in. You should land on
`/login`. Sign in; you should see your workspace exactly as before.

---

## 3. `CRON_SECRET`

Guards the three cron routes (`/api/cron/materialize-recurring`,
`sweep-time-entries`, `purge-soft-deleted`). Each one compares the
`Authorization: Bearer <secret>` header with `lib/safe-compare.ts` and
**fails closed with a 500 when the variable is unset**.

**Generate one**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Set it**

- Vercel → **Settings → Environment Variables** → `CRON_SECRET`,
  **Production** scope → save → redeploy.
- Vercel's cron scheduler sends `Authorization: Bearer $CRON_SECRET`
  automatically from that same variable, so there is no second place to update
  and no `vercel.json` change. The schedules in `vercel.json` stay as they are.
- `.env.local` keeps its own local value so `scripts/qa-cron-*.mjs` can still
  exercise the routes locally. Do not copy the production value there.

**User-visible effect:** none. There is no user-facing surface.

**Verify:** after the redeploy, wait for (or inspect) the next scheduled run in
Vercel → **Logs** / the cron's invocation list. A `401` means the header and the
env var disagree; a `500` means the env var is missing. Note that the purge cron
is still **dry-run by default** — it only deletes when `PURGE_ENABLED=true` —
so a cron misfire during rotation cannot erase anything.

---

## 4. Sentry DSN (lowest priority, but finish the job)

A DSN is a write-only ingest key and `NEXT_PUBLIC_SENTRY_DSN` is deliberately
shipped in the client bundle, so this is not a confidentiality problem. The
reason to rotate is quota abuse: anyone holding it can fire junk events into
your Sentry project. Rotate it because it shared a file with real secrets.

**Rotate it**

1. Sentry → **Settings → Projects → founderflow → Client Keys (DSN)**.
2. **Generate New Key**, copy the new DSN.
3. Update **both** Vercel Production variables — they carry the same value for
   two different runtimes:
   - `SENTRY_DSN` (server + edge: `sentry.server.config.ts`,
     `sentry.edge.config.ts`)
   - `NEXT_PUBLIC_SENTRY_DSN` (browser: `sentry.client.config.ts`)
4. Redeploy. `NEXT_PUBLIC_*` values are inlined **at build time**, so the
   browser half does not change until a fresh build — redeploy without the
   build cache if you want to be certain.
5. Only after you see events arriving on the new key: go back to **Client
   Keys** and **disable** the old one.

**User-visible effect:** none. Historical events and issues stay in Sentry;
nothing is deleted. Both SDKs no-op when the DSN is unset, so even a botched
value degrades to "no error reporting", never to a broken page.

---

## Not in scope here

- **`.env.local`** holds only local-development values (loopback Postgres,
  a dev `AUTH_SECRET`, a local `CRON_SECRET`, a local VAPID keypair, a local
  LemonSqueezy webhook secret). None of them reach production; none need
  rotating. Do not "helpfully" replace them with production values — that
  re-creates the original bug.
- **`.env`** is now value-free on purpose and must stay that way. Prisma loads
  it by default, so anything you put there is what a stray
  `npx prisma migrate reset` will connect to and drop.
  `tests/lib/env/no-prod-credentials.test.ts` fails if a value, a
  `supabase.co(m)` host, or a password on a non-loopback host reappears in any
  `.env*` file other than a `*.example` template.
- **Staging** has no provisioned Supabase project yet, so there is nothing to
  rotate there.

## Done checklist

- [ ] Supabase database password reset
- [ ] Vercel `DATABASE_URL` (Production) updated
- [ ] Vercel `DIRECT_URL` (Production) updated
- [ ] GitHub Actions `BACKUP_DATABASE_URL` updated
- [ ] Production redeployed, build green (migrate step passed), sign-in works
- [ ] Backup workflow run by hand, dump uploaded and non-trivial in size
- [ ] Vercel `AUTH_SECRET` (Production) rotated + redeployed, sign-in works
- [ ] Vercel `CRON_SECRET` (Production) rotated + redeployed, next cron returns 200
- [ ] New Sentry DSN set in `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`, old key disabled
- [ ] `env-backup-prod.txt` deleted from the temp directory
- [ ] Old password removed from any password manager entry / chat scrollback you pasted it into
