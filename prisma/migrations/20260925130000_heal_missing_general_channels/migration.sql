-- ─────────────────────────────────────────────────────────────────────
-- Heal workspaces that were created without a #general channel
-- ─────────────────────────────────────────────────────────────────────
--
-- WHY THIS EXISTS. 20260924100000_add_chat backfilled one #general per
-- company, and that was the ONLY thing that ever created one: `signupAction`
-- was never taught to, and `acceptInviteAction` was never taught to add a
-- ChannelMember. So every workspace created between that migration and
-- 2026-09-25 has zero channels — a customer signs up, clicks Chat, and lands
-- on the empty state — and every teammate invited in that window is in no
-- channel even where one exists, so they get no unread badges and are absent
-- from the member list.
--
-- The code path is fixed (lib/chat/bootstrap.ts, called from both actions).
-- This migration repairs the rows already written, which code cannot.
--
-- WHAT IT DELIBERATELY DOES NOT DO: it never touches a company that already
-- has ANY channel. A workspace whose #general was renamed, archived, or
-- deliberately deleted has made a choice, and a healing migration that
-- re-imposes a default over a deliberate choice is worse than the gap it
-- closes. Only genuinely channel-less workspaces get one.
--
-- IDEMPOTENT, properly this time. The ids are derived from the companyId and
-- the channel+user pair exactly as add_chat derived them, so a re-run computes
-- the same keys — and unlike add_chat, both INSERTs carry ON CONFLICT DO
-- NOTHING rather than relying on a re-run never happening. (add_chat's own
-- comment claimed idempotence "by primary key rather than by hope"; the hope
-- was doing more work than the primary key, because nothing caught the
-- conflict. Filed in FaultsAudit; not fixable in place, because editing an
-- applied migration changes its checksum and every existing database then
-- reports drift.)

-- ─────────────────────────────────────────────────────────────────────
-- 1. One #general for every live company that has no channel at all
-- ─────────────────────────────────────────────────────────────────────
--
-- Same createdBy ladder as add_chat: the company owner, else the earliest
-- live admin, else the earliest live user of any role. The live-user filter
-- matters — a tombstoned owner must not end up owning a channel everyone
-- can see.

INSERT INTO "Channel" ("id", "companyId", "kind", "slug", "name", "topic", "dmKey", "createdBy", "createdAt")
SELECT
  'chgen_' || substring(md5(c."id"), 1, 20)        AS id,
  c."id"                                           AS companyId,
  'public'                                         AS kind,
  'general'                                        AS slug,
  'general'                                        AS name,
  'Company-wide channel.'                          AS topic,
  NULL                                             AS dmKey,
  COALESCE(
    (SELECT u."id" FROM "User" u WHERE u."id" = c."ownerId" AND u."deletedAt" IS NULL),
    (SELECT u."id" FROM "User" u WHERE u."companyId" = c."id" AND u."deletedAt" IS NULL AND u."role" = 'admin' ORDER BY u."createdAt" ASC LIMIT 1),
    (SELECT u."id" FROM "User" u WHERE u."companyId" = c."id" AND u."deletedAt" IS NULL ORDER BY u."createdAt" ASC LIMIT 1)
  )                                                AS createdBy,
  CURRENT_TIMESTAMP                                AS createdAt
FROM "Company" c
WHERE c."deletedAt" IS NULL
  -- Must have someone in it. A company with no live users needs no channel,
  -- and createdBy would resolve to NULL and violate the FK.
  AND EXISTS (
    SELECT 1 FROM "User" u WHERE u."companyId" = c."id" AND u."deletedAt" IS NULL
  )
  -- The narrowing that makes this safe: no channel of ANY kind.
  AND NOT EXISTS (
    SELECT 1 FROM "Channel" ch WHERE ch."companyId" = c."id"
  )
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Every live user joins their company's #general
-- ─────────────────────────────────────────────────────────────────────
--
-- Deliberately NOT restricted to the channels created above. This also repairs
-- the second defect: a teammate who accepted an invite during the window
-- joined a workspace whose #general already existed and was never added to it.
-- ON CONFLICT makes re-adding an existing member a no-op, so one statement
-- covers both populations.
--
-- lastReadAt = CURRENT_TIMESTAMP so nobody logs in to a fabricated unread
-- badge for history they never saw.

INSERT INTO "ChannelMember" ("id", "channelId", "userId", "role", "joinedAt", "lastReadAt")
SELECT
  'chmem_' || substring(md5(ch."id" || ':' || u."id"), 1, 20) AS id,
  ch."id"                                          AS channelId,
  u."id"                                           AS userId,
  CASE WHEN u."id" = ch."createdBy" THEN 'owner' ELSE 'member' END AS role,
  CURRENT_TIMESTAMP                                AS joinedAt,
  CURRENT_TIMESTAMP                                AS lastReadAt
FROM "Channel" ch
JOIN "User" u
  ON u."companyId" = ch."companyId"
 AND u."deletedAt" IS NULL
WHERE ch."slug" = 'general'
  AND ch."archivedAt" IS NULL
ON CONFLICT DO NOTHING;
