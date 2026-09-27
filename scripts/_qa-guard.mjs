/*
 * Audit data-safety guard.
 *
 * THE RULE IT ENFORCES: during the go-live audit, no agent may write a single
 * row of pre-existing data. Every agent signs up its own throwaway workspace
 * and works only inside it. That is an instruction, and instructions are not
 * enforcement -- this file is the enforcement.
 *
 *   node scripts/_qa-guard.mjs baseline   # snapshot the demo workspace
 *   node scripts/_qa-guard.mjs verify     # fail loudly if anything moved
 *   node scripts/_qa-guard.mjs sweep      # delete leftover qa-* tenants
 *
 * WHY A CHECKSUM AND NOT JUST COUNTS: a count catches an insert or a delete but
 * not an UPDATE, and the most likely accident here is exactly an update -- a
 * script flipping a seeded user's role, deletedAt or sessionVersion "just for a
 * moment" and restoring it imperfectly. scripts/smoke-session-invalidation.mjs
 * already does this today, and restores sessionVersion to the literal 0 rather
 * than the prior value. So the snapshot hashes whole rows.
 *
 * WHY A SWEEPER: prisma/seed.ts scopes its deleteMany to DEMO_COMPANY_ID, so
 * agent tenants survive a reseed and would otherwise accumulate forever.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { localDb } from "./_local-db.mjs";

const DEMO_COMPANY_ID = "demo-nimbus";
/** Agent tenants are named with this prefix so the sweeper can find them. */
const QA_PREFIX = "qa-";
const SNAPSHOT = new URL("../.qa-baseline.json", import.meta.url);

const db = localDb();

/**
 * Every table that carries demo-workspace data, with how to scope it to one
 * company. Ordered children-first so the sweeper can delete without leaning on
 * cascade -- the same discipline the purge cron uses.
 */
const TABLES = [
  ["messageReaction", (id) => ({ message: { companyId: id } })],
  ["message", (id) => ({ companyId: id })],
  ["channelMember", (id) => ({ channel: { companyId: id } })],
  ["channel", (id) => ({ companyId: id })],
  ["comment", (id) => ({ companyId: id })],
  ["timeEntry", (id) => ({ companyId: id })],
  ["notification", (id) => ({ companyId: id })],
  ["activity", (id) => ({ companyId: id })],
  ["inviteToken", (id) => ({ companyId: id })],
  ["recurringRule", (id) => ({ companyId: id })],
  ["budget", (id) => ({ companyId: id })],
  ["transaction", (id) => ({ companyId: id })],
  ["task", (id) => ({ companyId: id })],
  ["project", (id) => ({ companyId: id })],
  ["notificationPreference", (id) => ({ user: { companyId: id } })],
  ["pushSubscription", (id) => ({ user: { companyId: id } })],
  ["user", (id) => ({ companyId: id })],
];

/** Stable stringify: Decimal/Date/BigInt all become comparable strings. */
function stable(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "object" && typeof v.toFixed === "function") return v.toString(); // Decimal
    return v;
  });
}

async function snapshot(companyId) {
  const out = {};
  for (const [model, scope] of TABLES) {
    const rows = await db[model].findMany({ where: scope(companyId) });
    // Sort by id so row order from the driver can never move the hash.
    rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    out[model] = {
      count: rows.length,
      hash: createHash("sha256").update(stable(rows)).digest("hex").slice(0, 16),
    };
  }
  const company = await db.company.findUnique({ where: { id: companyId } });
  out.company = {
    count: company ? 1 : 0,
    hash: createHash("sha256").update(stable(company)).digest("hex").slice(0, 16),
  };
  return out;
}

async function cmdBaseline() {
  const snap = await snapshot(DEMO_COMPANY_ID);
  writeFileSync(SNAPSHOT, JSON.stringify({ takenAt: new Date().toISOString(), snap }, null, 2));
  const total = Object.values(snap).reduce((n, t) => n + t.count, 0);
  console.log(`  baseline written — ${total} rows across ${Object.keys(snap).length} tables`);
  for (const [t, v] of Object.entries(snap)) if (v.count) console.log(`    ${t}: ${v.count}`);
}

async function cmdVerify() {
  if (!existsSync(SNAPSHOT)) {
    console.error("  ✗ no baseline — run `node scripts/_qa-guard.mjs baseline` first");
    process.exit(2);
  }
  const { takenAt, snap: before } = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const after = await snapshot(DEMO_COMPANY_ID);

  const drift = [];
  for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[table] ?? { count: 0, hash: "-" };
    const a = after[table] ?? { count: 0, hash: "-" };
    if (b.count !== a.count) drift.push(`${table}: ${b.count} -> ${a.count} rows`);
    else if (b.hash !== a.hash) drift.push(`${table}: same ${a.count} rows but CONTENT CHANGED (an update)`);
  }

  if (drift.length === 0) {
    console.log(`  ok  demo workspace untouched since ${takenAt}`);
    return;
  }
  console.error(`  FAIL  demo workspace was MODIFIED since ${takenAt}:`);
  for (const d of drift) console.error(`          ${d}`);
  console.error("\n  The audit's data-safety rule is that agents work only inside their own");
  console.error("  qa-* tenant. Something wrote to existing data. Find it before trusting");
  console.error("  any finding from this phase.");
  process.exitCode = 1;
}

async function cmdSweep() {
  const tenants = await db.company.findMany({
    where: { name: { startsWith: QA_PREFIX } },
    select: { id: true, name: true },
  });
  if (tenants.length === 0) {
    console.log("  ok  no qa-* tenants to sweep");
    return;
  }
  let rows = 0;
  for (const t of tenants) {
    for (const [model, scope] of TABLES) {
      const { count } = await db[model].deleteMany({ where: scope(t.id) });
      rows += count;
    }
    await db.company.update({ where: { id: t.id }, data: { ownerId: null } }).catch(() => {});
    await db.user.deleteMany({ where: { companyId: t.id } });
    await db.company.delete({ where: { id: t.id } });
    rows += 1;
    console.log(`    swept ${t.name}`);
  }
  console.log(`  ok  ${tenants.length} tenant(s), ${rows} rows removed`);
}

const cmd = process.argv[2];
const run = { baseline: cmdBaseline, verify: cmdVerify, sweep: cmdSweep }[cmd];
if (!run) {
  console.error("usage: node scripts/_qa-guard.mjs <baseline|verify|sweep>");
  process.exit(2);
}
run()
  .catch((e) => {
    console.error("qa-guard threw:", e.message);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
