/**
 * Prisma client singleton.
 *
 * Hot-reload in Next dev creates a new module instance on every change; without
 * stashing the client on `globalThis`, we'd leak connections until the process
 * crashes. In prod each lambda gets one client for its lifetime.
 *
 * The client is extended with a query hook that fires a Web Push whenever a
 * Notification row is created — one choke point so every notification source
 * (current and future) delivers a push without per-callsite wiring. The push
 * is fire-and-forget and best-effort; the durable Notification row is the
 * source of truth. (A notification created inside a transaction that then rolls
 * back could send a stray push — rare, and harmless relative to the wiring it
 * saves.)
 */

import { PrismaClient } from "@prisma/client";

type NotificationRowLike = {
  userId: string;
  title: string;
  message: string;
  link?: string | null;
  category?: string | null;
};

// Fire-and-forget push. Lazy import breaks the db ↔ push module cycle.
function firePush(rows: NotificationRowLike[]): void {
  if (rows.length === 0) return;
  import("@/lib/push/notify").then((m) => m.pushForNotificationRows(rows)).catch(() => {});
}

const prismaClientSingleton = () =>
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  }).$extends({
    query: {
      notification: {
        async create({ args, query }) {
          const row = await query(args);
          firePush([row as unknown as NotificationRowLike]);
          return row;
        },
        async createMany({ args, query }) {
          const result = await query(args);
          const data = args.data;
          const rows = (Array.isArray(data) ? data : data ? [data] : []) as NotificationRowLike[];
          firePush(rows);
          return result;
        },
      },
    },
  });

type ExtendedPrismaClient = ReturnType<typeof prismaClientSingleton>;

const globalForPrisma = globalThis as unknown as {
  prisma: ExtendedPrismaClient | undefined;
};

export const db = globalForPrisma.prisma ?? prismaClientSingleton();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
