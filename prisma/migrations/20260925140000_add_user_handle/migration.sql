-- ─────────────────────────────────────────────────────────────────────
-- User.handle — give every teammate a parser-addressable name
-- ─────────────────────────────────────────────────────────────────────
--
-- WHY THIS EXISTS. FaultsAudit T16: a teammate whose name is written in Urdu
-- script cannot be @mentioned at all. slugifyName() (lib/comments/mentions.ts)
-- ends in `.replace(/[^a-z0-9-]/g, "")`, so a name carrying no ASCII letters
-- slugifies to the EMPTY STRING. The product ships a full Urdu locale, so that
-- is a user who is structurally unaddressable inside their own workspace, with
-- nothing in the UI explaining why.
--
-- The fix is a separate `handle`: typable on any keyboard, unique per company,
-- derived from the email local-part. The rejected alternative — widening the
-- mention regex to `\p{L}` — is argued against on the column comment in
-- schema.prisma; short version, `@` followed by Urdu prose has no ASCII word
-- boundary to stop at, so the parser can no longer tell where the mention ends.
--
-- ORDER OF OPERATIONS, and why:
--   1. Add the column NULLABLE. A NOT NULL column would need a backfill that
--      provably cannot fail for any historical row, and this one has to cope
--      with local-parts that sanitise to nothing.
--   2. Backfill every existing row, de-duplicated deterministically.
--   3. Create the unique index LAST. If step 2 ever produced a collision the
--      index creation fails and the whole migration rolls back (Prisma applies
--      each migration in one transaction) — a loud backfill bug, not a
--      half-applied schema.
--
-- IDEMPOTENT. `ADD COLUMN IF NOT EXISTS`, a backfill guarded on
-- `"handle" IS NULL` so a re-run cannot renumber people who already have one,
-- `CREATE UNIQUE INDEX IF NOT EXISTS`, and a window ordered by
-- (createdAt, id) so a replayed database derives the SAME assignment rather
-- than a fresh shuffle. (Partial re-runs — some rows handled, some NULL — are
-- only reachable if rows are inserted with a NULL handle after this lands; the
-- unique index from step 3 is the backstop there, and the write path the
-- mention work adds is what keeps it from happening.)

-- ─────────────────────────────────────────────────────────────────────
-- 1. Column
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "handle" TEXT;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Backfill from the email local-part
-- ─────────────────────────────────────────────────────────────────────
--
-- Soft-deleted users are backfilled too, deliberately. A tombstoned row still
-- occupies its slot in the unique index; skipping it would let a live teammate
-- take the handle and then break the restore documented in CLAUDE.md.
--
-- The derivation, in four steps, each of which the de-duplication below
-- depends on:
--
--   local_part  split_part(lower(email), '@', 1)
--   cleaned     strip everything outside [a-z0-9-]  →  collapse hyphen runs
--               →  trim leading/trailing hyphens
--   base        force a leading ASCII LETTER, then fall back if empty
--   handle      base, or base || '--' || n for the 2nd+ holder of that base
--
-- WHY FORCE A LEADING LETTER. MENTION_REGEX in lib/comments/mentions.ts is
-- /@([a-zA-Z][a-zA-Z0-9-]*)/ — the first character must be a letter so `@2024`
-- does not tokenize as a mention. A handle of `2024ali` would therefore be
-- exactly as unaddressable as the empty string this migration exists to fix,
-- so `2024ali@x.com` becomes `u2024ali`.
--
-- WHY A FALLBACK AT ALL. An all-Urdu local part is possible (and is precisely
-- the population T16 is about), as is a local-part of nothing but dots or plus
-- signs; both sanitise to ''. An empty handle is not addressable and not
-- unique, so those rows get `user-<first 8 of md5(id)>` — derived from the
-- primary key, so it is stable across a re-run, starts with a letter, and
-- contains only [a-z0-9-]. It is deliberately ugly: a machine-assigned handle
-- should look machine-assigned so the owner renames it once a rename control
-- exists.
--
-- WHY THE '--' SEPARATOR, AND WHY IT IS COLLISION-FREE. Two people in the SAME
-- company with ali@x.com and ali@y.com both derive `ali`. A plain numeric
-- suffix is not safe — `ali` + `ali` + `ali2@z.com` would hand out ali, ali2,
-- ali2. A DOUBLE hyphen is safe because the cleaning step collapses every run
-- of hyphens to one and trims the ends, so no derived base can ever contain
-- `--`. Therefore `ali--2` is unreachable as a base, and two different bases
-- can never produce the same suffixed handle either (that would require a base
-- containing `--`). The ordering (createdAt, then id as the tiebreak) is total
-- and stable, so the earliest-joined teammate keeps the clean `ali`.

WITH candidate AS (
  SELECT
    u."id"  AS user_id,
    b.base  AS base,
    row_number() OVER (
      PARTITION BY u."companyId", b.base
      ORDER BY u."createdAt" ASC, u."id" ASC
    )       AS n
  FROM "User" u
  CROSS JOIN LATERAL (
    -- COLLATE "C" is load-bearing, not decoration. `[a-z]` is a RANGE, and the
    -- SQL standard leaves ranges collation-dependent; under a linguistic
    -- collation `e` and `e-acute` sort adjacently, so a range could admit
    -- letters that are not ASCII at all. This backfill exists precisely to
    -- produce an ASCII-only handle, so the comparison is pinned to code-point
    -- order and stops depending on which collation the cluster was initdb'd
    -- with. Local docker Postgres 16 and Supabase do not agree on that.
    SELECT split_part(lower(u."email"), '@', 1) COLLATE "C" AS local_part
  ) l
  CROSS JOIN LATERAL (
    SELECT regexp_replace(
             regexp_replace(
               regexp_replace(l.local_part, '[^a-z0-9-]', '', 'g'),
               '-{2,}', '-', 'g'
             ),
             '^-+|-+$', '', 'g'
           ) AS cleaned
  ) c
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN c.cleaned COLLATE "C" ~ '^[a-z]' THEN c.cleaned
             WHEN c.cleaned <> ''                  THEN 'u' || c.cleaned
             ELSE 'user-' || substring(md5(u."id"), 1, 8)
           END AS base
  ) b
  WHERE u."handle" IS NULL
)
UPDATE "User" u
SET "handle" = CASE
                 WHEN candidate.n = 1 THEN candidate.base
                 ELSE candidate.base || '--' || candidate.n
               END
FROM candidate
WHERE u."id" = candidate.user_id;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Unique index, last
-- ─────────────────────────────────────────────────────────────────────
--
-- Name matches what Prisma derives from @@unique([companyId, handle]) on User,
-- so `prisma migrate dev` sees no drift and does not try to rename it.
--
-- NULLs coexist freely underneath this. Postgres unique indexes are NULLS
-- DISTINCT by default, and a multi-column key is only a duplicate when EVERY
-- column matches — a NULL never equals a NULL, so a row with a NULL handle
-- can never conflict with anything. That is what makes the nullable column
-- safe:
-- any number of handle-less users can sit in one company at once.

CREATE UNIQUE INDEX IF NOT EXISTS "User_companyId_handle_key" ON "User"("companyId", "handle");
