-- Session-invalidation counter. Additive + NOT NULL DEFAULT 0 so every
-- existing row backfills to 0 and current sessions stay valid (their JWT also
-- carries 0). Bumping this column force-invalidates a user's live sessions.
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
