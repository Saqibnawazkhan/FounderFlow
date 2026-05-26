// One-off: confirm the seeded demo user exists in Supabase and the password
// hash matches "demo123". Useful when login mysteriously fails.

import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const email = process.argv[2] ?? "demo@founderflow.app";
const password = process.argv[3] ?? "demo123";

const user = await db.user.findUnique({ where: { email } });

if (!user) {
  console.log(`❌ no user with email "${email}" in the DB`);
  const all = await db.user.findMany({ select: { email: true, role: true } });
  console.log(`existing users: ${JSON.stringify(all, null, 2)}`);
} else {
  const ok = await bcrypt.compare(password, user.passwordHash);
  console.log(
    `user: ${user.name} <${user.email}> (role: ${user.role}, companyId: ${user.companyId})`
  );
  console.log(`password "${password}" matches stored hash: ${ok ? "✅" : "❌"}`);
  const txns = await db.transaction.count({ where: { companyId: user.companyId } });
  const tasks = await db.task.count({ where: { companyId: user.companyId } });
  console.log(`company has ${txns} transactions, ${tasks} tasks`);
}

await db.$disconnect();
