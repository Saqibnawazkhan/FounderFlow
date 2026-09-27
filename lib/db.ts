/**
 * Prisma client singleton.
 *
 * Hot-reload in Next dev creates a new module instance on every change; without
 * stashing the client on `globalThis`, we'd leak connections until the process
 * crashes. In prod each lambda gets one client for its lifetime.
 *
 * This client used to carry a `$extends` query hook that fired a Web Push on
 * every Notification write. That moved to lib/notify/fan-out.ts (2026-09-24):
 * the hook could only see a row, never the EVENT that produced it, so it could
 * not honour a per-event push preference. The fan-out has both in hand, and is
 * now the only place a notification is written from — enforced by
 * tests/lib/notify/fan-out-sites.test.ts. Losing the hook also removes its
 * documented flaw, where a notification created inside a transaction that
 * later rolled back still sent a stray push.
 */

import { PrismaClient } from "@prisma/client";

const prismaClientSingleton = () =>
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

type AppPrismaClient = ReturnType<typeof prismaClientSingleton>;

const globalForPrisma = globalThis as unknown as {
  prisma: AppPrismaClient | undefined;
};

export const db = globalForPrisma.prisma ?? prismaClientSingleton();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
