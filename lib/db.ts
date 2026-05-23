/**
 * Prisma client singleton.
 *
 * Hot-reload in Next dev creates a new module instance on every change; without
 * stashing the client on `globalThis`, we'd leak connections until the process
 * crashes. In prod each lambda gets one client for its lifetime.
 */

import { PrismaClient } from "@/lib/generated/prisma";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
