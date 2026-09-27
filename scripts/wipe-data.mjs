/**
 * Wipe all rows from every app table but leave the schema intact.
 * Intended for clearing demo seed data from the dev DB before real signups.
 *
 * Run: node scripts/wipe-data.mjs
 *
 * There is no confirmation prompt and every deleteMany() below is UNSCOPED —
 * this empties every company, user, task and transaction in whatever database
 * it is pointed at. That used to be guarded by nothing but the operator
 * remembering which database `.env` named — and `.env` named PRODUCTION until
 * it was emptied on 2026-09-26 (see SECRET-ROTATION.md). Both facts are now
 * historical, and neither is what protects this script.
 *
 * It is now guarded structurally: localDb() reads `.env.local` and throws on
 * any non-loopback host, so this script cannot reach a hosted database even if
 * someone runs it by accident. Do not "helpfully" restore a fallback to
 * process.env.DATABASE_URL.
 */

import { localDb } from "./_local-db.mjs";

// Pinned to the local docker Postgres. A bare `new PrismaClient()` here
// auto-loads the ROOT .env. That file is value-free since 2026-09-26, so a
// bare client now fails closed rather than silently reaching production — but
// do NOT rely on that: the guarantee is localDb()'s loopback check, which holds
// whatever .env happens to contain. See scripts/_local-db.mjs. This script mutates data; it must never be able
// to reach a hosted database.
const db = localDb();

async function main() {
  // Pre-count so we can show what we removed.
  const before = {
    notifications: await db.notification.count(),
    activities: await db.activity.count(),
    tasks: await db.task.count(),
    transactions: await db.transaction.count(),
    users: await db.user.count(),
    companies: await db.company.count(),
  };

  console.log("Before:", before);

  // Delete in FK-safe order (children first, parents last).
  await db.notification.deleteMany();
  await db.activity.deleteMany();
  await db.task.deleteMany();
  await db.transaction.deleteMany();
  // Break User <-> Company circular FK: clear Company.ownerId first so the
  // user delete doesn't violate the constraint.
  await db.company.updateMany({ data: { ownerId: null } });
  await db.user.deleteMany();
  await db.company.deleteMany();

  const after = {
    notifications: await db.notification.count(),
    activities: await db.activity.count(),
    tasks: await db.task.count(),
    transactions: await db.transaction.count(),
    users: await db.user.count(),
    companies: await db.company.count(),
  };

  console.log("After: ", after);
  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
