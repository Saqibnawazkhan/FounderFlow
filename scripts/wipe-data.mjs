/**
 * Wipe all rows from every app table but leave the schema intact.
 * Intended for clearing demo seed data from the dev DB before real signups.
 *
 * Run: node scripts/wipe-data.mjs
 *
 * NOT for production — there's no confirmation prompt; the .env must be
 * pointing at the dev DB.
 */

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

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
