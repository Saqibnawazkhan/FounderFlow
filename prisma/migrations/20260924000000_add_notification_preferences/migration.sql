-- add_notification_preferences
--
-- Strategy: pure CreateTable, no backfill.
--
-- A missing row means "use the defaults in lib/notify/preferences.ts", so
-- every existing user is already correctly configured the moment this lands,
-- and a new NotifyEvent can ship later without a data migration. The row is
-- written lazily, the first time someone changes a switch.
--
-- Enforcement lives in lib/notify/fan-out.ts, the single path by which a
-- Notification row is created (FaultsAudit S9). tests/lib/notify/
-- fan-out-sites.test.ts fails the build if anything writes around it.
--
-- onDelete: Cascade — preferences are worthless once the user is gone, and
-- they carry nothing anyone would want to recover.

CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "inApp" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "push" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- One row per person per event; the settings form upserts on this.
CREATE UNIQUE INDEX "NotificationPreference_userId_event_key"
    ON "NotificationPreference"("userId", "event");

-- The fan-out reads every preference for a set of recipients in one query.
CREATE INDEX "NotificationPreference_userId_idx"
    ON "NotificationPreference"("userId");

ALTER TABLE "NotificationPreference"
    ADD CONSTRAINT "NotificationPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
