-- add_chat migration
--
-- Strategy: introduce the four chat tables (Channel, ChannelMember, Message,
-- MessageReaction) AND backfill a #general channel per existing workspace in
-- one atomic step, so every live user lands in a channel on first login
-- instead of an empty rail. Order of operations:
--
--   1. Create all four tables. Nothing references them yet, so there is no
--      ordering constraint between them at this point.
--   2. Backfill one "#general" Channel per Company that still has at least one
--      LIVE user. The id is DETERMINISTIC ('chgen_' || md5(companyId)) so a
--      re-run — a replayed migration, a restored-then-reapplied database —
--      collides on the primary key instead of quietly creating a second
--      #general. Tombstoned (soft-deleted) workspaces are skipped by the same
--      live-user guard: a workspace with no live users gets nothing.
--   3. Backfill a ChannelMember row for every LIVE user of those companies,
--      with lastReadAt = now(). Seeding the watermark at creation time is the
--      whole point: the channel has no messages yet, so an epoch-zero
--      watermark would greet everyone with a fabricated unread badge.
--   4. Indexes, created after the bulk INSERTs so the backfill is not paying
--      to maintain them row by row.
--   5. Foreign keys with EXPLICIT ON DELETE, added last so the backfill cannot
--      trip a constraint mid-flight.
--
-- Wrapped in a single SQL file; Prisma applies each migration in its own
-- transaction, so a failure rolls back cleanly.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    -- "public" | "private" | "dm" — zod (lib/schemas/chat.ts) owns the union.
    "kind" TEXT NOT NULL,
    -- URL segment; for a DM this is the dmKey.
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "topic" TEXT,
    -- Sorted "userIdA:userIdB"; NULL for non-DMs.
    "dmKey" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Archive is a soft close: history stays readable, posting is refused.
    "archivedAt" TIMESTAMP(3),
    -- Denormalized so the rail sorts by recency without an aggregate.
    "lastMessageAt" TIMESTAMP(3),

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelMember" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- "owner" | "member".
    "role" TEXT NOT NULL DEFAULT 'member',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Read watermark; unread = newer messages not authored by me.
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Deliberately NOT a foreign key — a watermark, not a reference.
    "lastReadMessageId" TEXT,
    "mutedAt" TIMESTAMP(3),

    CONSTRAINT "ChannelMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    -- Denormalized — survives a rename, exactly like Comment.
    "authorName" TEXT NOT NULL,
    "authorAvatar" TEXT,
    -- "text" | "card".
    "kind" TEXT NOT NULL DEFAULT 'text',
    "body" TEXT NOT NULL,
    -- JSON, versioned — for kind "card"; NULL for text.
    "payload" TEXT,
    -- Thread root; self-relation, SET NULL so purging a root keeps its replies.
    "parentId" TEXT,
    -- Denormalized so a root row renders "5 replies" without an aggregate.
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    -- Resolved userIds as a JSON array, same as Comment.
    "mentions" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    -- Tombstone. Message is the SEVENTH soft-delete table: a deleted message
    -- must not silently rewrite history.
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MessageReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- One of the fixed REACTION_EMOJI allow-list in lib/schemas/chat.ts.
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageReaction_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────
-- 2. Backfill: one #general Channel per company that has live users
-- ─────────────────────────────────────────────────────────────────────
--
-- The id is derived from the companyId, not generated, so this INSERT is
-- idempotent by primary key rather than by hope. createdBy defaults to the
-- company owner, falling back to the earliest live admin, then the earliest
-- live user of any role — the same ladder the add_projects backfill used,
-- with the live-user filter added because a tombstoned owner must not end up
-- owning a channel everybody can see.

INSERT INTO "Channel" ("id", "companyId", "kind", "slug", "name", "topic", "dmKey", "createdBy", "createdAt")
SELECT
  'chgen_' || substring(md5(c."id"), 1, 20)        AS id,
  c."id"                                           AS companyId,
  'public'                                         AS kind,
  'general'                                        AS slug,
  'general'                                        AS name,
  'Company-wide channel. Auto-created on the chat rollout.' AS topic,
  NULL                                             AS dmKey,
  COALESCE(
    (SELECT u."id" FROM "User" u WHERE u."id" = c."ownerId" AND u."deletedAt" IS NULL),
    (SELECT u."id" FROM "User" u WHERE u."companyId" = c."id" AND u."deletedAt" IS NULL AND u."role" = 'admin' ORDER BY u."createdAt" ASC LIMIT 1),
    (SELECT u."id" FROM "User" u WHERE u."companyId" = c."id" AND u."deletedAt" IS NULL ORDER BY u."createdAt" ASC LIMIT 1)
  )                                                AS createdBy,
  CURRENT_TIMESTAMP                                AS createdAt
FROM "Company" c
WHERE EXISTS (
  SELECT 1 FROM "User" u WHERE u."companyId" = c."id" AND u."deletedAt" IS NULL
);

-- ─────────────────────────────────────────────────────────────────────
-- 3. Backfill: every live user joins their company's #general
-- ─────────────────────────────────────────────────────────────────────
--
-- lastReadAt = now() so nobody logs in to a fake unread badge. The channel
-- creator gets role 'owner' (they can rename/archive it); everyone else joins
-- as 'member'. The member id is likewise deterministic, keyed on
-- channel + user, for the same re-run safety as the channel above; the unique
-- index in section 4 is the hard guarantee.

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
WHERE ch."slug" = 'general';

-- ─────────────────────────────────────────────────────────────────────
-- 4. Indexes
-- ─────────────────────────────────────────────────────────────────────

-- Slugs are per-workspace: two companies may both have #general.
CREATE UNIQUE INDEX "Channel_companyId_slug_key"         ON "Channel"("companyId", "slug");
-- One DM per ordered pair per workspace — the anti-fork guarantee. NULLs do
-- not collide in Postgres, so non-DM channels are unaffected.
CREATE UNIQUE INDEX "Channel_companyId_dmKey_key"        ON "Channel"("companyId", "dmKey");
CREATE INDEX "Channel_companyId_kind_idx"                ON "Channel"("companyId", "kind");
CREATE INDEX "Channel_companyId_lastMessageAt_idx"       ON "Channel"("companyId", "lastMessageAt");

CREATE UNIQUE INDEX "ChannelMember_channelId_userId_key" ON "ChannelMember"("channelId", "userId");
CREATE INDEX "ChannelMember_userId_idx"                  ON "ChannelMember"("userId");

CREATE INDEX "Message_channelId_createdAt_idx"           ON "Message"("channelId", "createdAt");
CREATE INDEX "Message_channelId_parentId_createdAt_idx"  ON "Message"("channelId", "parentId", "createdAt");
CREATE INDEX "Message_companyId_createdAt_idx"           ON "Message"("companyId", "createdAt");
CREATE INDEX "Message_authorId_idx"                      ON "Message"("authorId");
CREATE INDEX "Message_deletedAt_idx"                     ON "Message"("deletedAt");

CREATE UNIQUE INDEX "MessageReaction_messageId_userId_emoji_key" ON "MessageReaction"("messageId", "userId", "emoji");
CREATE INDEX "MessageReaction_messageId_idx"             ON "MessageReaction"("messageId");

-- ─────────────────────────────────────────────────────────────────────
-- 5. Foreign keys (explicit ON DELETE)
-- ─────────────────────────────────────────────────────────────────────
--
-- CASCADE for company + channel ownership: erasing a workspace or a channel
-- takes its chat with it. CASCADE on the user-facing FKs too, deliberately —
-- the only path that hard-deletes a User is whole-workspace erasure (the purge
-- cron has no individual-user stage, by design), so RESTRICT here would buy no
-- safety and would jam that transaction on tables the cron does not know
-- about. Message.parentId is SET NULL so purging a thread root promotes its
-- replies to roots instead of cascading the whole thread away.

ALTER TABLE "Channel"
  ADD CONSTRAINT "Channel_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Channel"
  ADD CONSTRAINT "Channel_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelMember"
  ADD CONSTRAINT "ChannelMember_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelMember"
  ADD CONSTRAINT "ChannelMember_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Message"
  ADD CONSTRAINT "Message_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MessageReaction"
  ADD CONSTRAINT "MessageReaction_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MessageReaction"
  ADD CONSTRAINT "MessageReaction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
