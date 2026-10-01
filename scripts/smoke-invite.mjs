// Smoke-test Phase 6 (email-invite slice): full round-trip from admin
// invite → token landed in DB → recipient visits /invite/[token] → sets
// password → auto-signed-in.
//
// In dev (no GMAIL_USER / GMAIL_APP_PASSWORD) the action returns the invite
// URL directly,
// so we don't need to scrape a mailbox.

import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

/**
 * This script's own rate-limit bucket (audit harness-009). Every puppeteer
 * request in dev arrives with no forwarding header, so lib/client-ip.ts finds no
 * trusted address and lib/rate-limit.ts falls back to per-ACCOUNT limits — which
 * means two scripts signing in as the same seeded user share one 5-per-minute
 * budget, and whichever runs second reports "cannot sign in". A distinct address
 * per script is what lib/client-ip.ts already documents the harness as relying
 * on, and what every scripts/qa-*.mjs already does on 10.99.0.x.
 *
 * tests/ops/smoke-hygiene.test.ts asserts these are unique across the directory
 * and that every page created here is given one.
 */
const SMOKE_IP = "10.98.0.11";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
// 3000, not 3009 (team-and-invites-009). CLAUDE.md's "Local development from
// scratch" runs `npm run dev` on 3000, so the old default meant a run with no
// BASE in the environment failed at the first goto and never reached step 3.
// Override it when the port is taken — and override AUTH_URL to match, or the
// auth redirect breaks.
const BASE = process.env.BASE ?? "http://localhost:3000";

// Pinned to the local docker Postgres. A bare `new PrismaClient()` here
// auto-loads the ROOT .env, which points at production Supabase — see
// scripts/_local-db.mjs. This script mutates data; it must never be able
// to reach a hosted database.
const db = localDb();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
});

const stamp = Date.now();
const inviteEmail = `invite-${stamp}@founderflow.app`;
const inviteName = `Invite Test ${stamp}`;
// CAPITAL C, and it is the whole of team-and-invites-009's first half. This was
// `claim-${stamp}`: lowercase letters and digits, no uppercase. PasswordSchema
// (lib/schemas/password.ts) requires lowercase AND uppercase AND a digit, and
// AcceptInviteSchema embeds it, so acceptInviteAction answered "Password needs
// an uppercase letter" on every run and step 3 could never succeed.
// tests/ops/smoke-invite-contract.test.ts pushes this literal through the real
// schema so it cannot rot again.
const newPassword = `Claim-${stamp}`;

// THE WORKSPACE UNDER TEST, and every count below is scoped to it. These two
// reads were `db.user.count()` and `db.inviteToken.count()` — every tenant in the
// database at once, which is unsound as a before/after comparison the moment
// anything else is writing and meaningless as context.
//
// STILL THE SEEDED DEMO WORKSPACE, not a throwaway tenant of its own. That is the
// remaining half of team-and-invites-009: a run adds an Activity row and a
// #general membership that the cleanup below does not remove. Fixing it properly
// means signing up a fresh workspace through the UI and tearing the whole tenant
// down afterwards, which is a rewrite of this script.
const ADMIN_EMAIL = "demo@founderflow.app";
const admin = await db.user.findUnique({
  where: { email: ADMIN_EMAIL },
  select: { companyId: true },
});
if (!admin) {
  console.error(`❌ no ${ADMIN_EMAIL} in the local database — seed it first`);
  await browser.close();
  await db.$disconnect();
  process.exit(1);
}
const companyId = admin.companyId;

const beforeUsers = await db.user.count({ where: { companyId } });
const beforeTokens = await db.inviteToken.count({ where: { companyId } });
console.log(`DB before (${companyId}): users=${beforeUsers} invite_tokens=${beforeTokens}`);

/* ── 1. Admin logs in + sends the invite ──────────────────────────────── */
const adminPage = await browser.newPage();
await adminPage.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
adminPage.on("pageerror", (e) => console.error("ADMIN PAGEERROR:", e.message));

await adminPage.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await adminPage.waitForSelector("input[name=email]", { timeout: 30_000 });
await new Promise((r) => setTimeout(r, 500));
await adminPage.type("input[name=email]", "demo@founderflow.app");
await adminPage.type("input[name=password]", "demo123");
await adminPage.evaluate(() => document.querySelector("form")?.requestSubmit());
await adminPage
  .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 15_000 })
  .catch(() => {});
console.log(`admin signed in -> ${adminPage.url()}`);

await adminPage.goto(`${BASE}/team`, { waitUntil: "networkidle2" });
// /team is RSC; loading.tsx skeleton paints first, real article tags appear
// once Supabase round-trip completes. Give it a generous window on cold dev.
await adminPage
  .waitForFunction(() => document.querySelectorAll("article").length > 0, { timeout: 30_000 })
  .catch(() => {});

const btnClicked = await adminPage.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((b) =>
    /invite member/i.test(b.textContent ?? "")
  );
  if (!btn) return false;
  btn.click();
  return true;
});
console.log(`invite-member button clicked: ${btnClicked}`);
await adminPage.waitForSelector('[role="dialog"] input', { timeout: 15_000 });

await adminPage.evaluate(
  ({ name, email }) => {
    const dialog = document.querySelector('[role="dialog"]');
    const inputs = dialog?.querySelectorAll("input");
    if (!inputs || inputs.length < 2) return;
    const [nameEl, emailEl] = inputs;
    const setVal = (el, v) => {
      el.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setVal(nameEl, name);
    setVal(emailEl, email);
  },
  { name: inviteName, email: inviteEmail }
);

await adminPage.evaluate(() => {
  document.querySelector('[role="dialog"] form')?.requestSubmit();
});
// Wait for the modal to close (success path).
await adminPage
  .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 8000 })
  .catch(() => {});

const tokenRow = await db.inviteToken.findFirst({
  where: { email: inviteEmail, companyId },
  orderBy: { createdAt: "desc" },
});
console.log(
  tokenRow
    ? `✅ invite token created: ${tokenRow.token.slice(0, 12)}… role=${tokenRow.role} expiresAt=${tokenRow.expiresAt.toISOString().slice(0, 10)}`
    : "❌ invite token row NOT found"
);
if (!tokenRow) {
  await browser.close();
  await db.$disconnect();
  process.exit(1);
}

const userCreatedAtInvite = await db.user.findUnique({ where: { email: inviteEmail } });
console.log(
  userCreatedAtInvite === null
    ? "✅ user NOT yet created at invite-time (token-based flow)"
    : "❌ user was created prematurely"
);

/* ── 2. Recipient visits /invite/[token] in a fresh browser context ──── */
const recipientPage = await browser.newPage();
await recipientPage.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
recipientPage.on("pageerror", (e) => console.error("RECIPIENT PAGEERROR:", e.message));

const inviteUrl = `${BASE}/invite/${tokenRow.token}`;
await recipientPage.goto(inviteUrl, { waitUntil: "networkidle2" });

const greeting = await recipientPage.evaluate(() =>
  document.querySelector("h1")?.textContent?.trim()
);
console.log(`/invite page heading: "${greeting}"`);
const isWelcome = /welcome to/i.test(greeting ?? "");
console.log(
  isWelcome
    ? "✅ invite page rendered Welcome state (not the expired/invalid empty state)"
    : "❌ invite page rendered the wrong state"
);

/* ── 3. Recipient sets password + submits ─────────────────────────────── */
await recipientPage.waitForSelector("input[type=password]", { timeout: 10_000 });
await new Promise((r) => setTimeout(r, 300));
await recipientPage.evaluate((pw) => {
  const el = document.querySelector("input[type=password]");
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(el, pw);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, newPassword);

await recipientPage.evaluate(() => document.querySelector("form")?.requestSubmit());

await recipientPage
  .waitForFunction(() => location.pathname.startsWith("/dashboard"), { timeout: 20_000 })
  .catch(() => {});

const settledUrl = recipientPage.url();
console.log(
  /\/dashboard/.test(settledUrl)
    ? `✅ recipient auto-signed-in and landed on ${settledUrl}`
    : `❌ recipient ended up on ${settledUrl}`
);

/* ── 4. DB verification ────────────────────────────────────────────────── */
const createdUser = await db.user.findUnique({ where: { email: inviteEmail } });
const tokenAfter = await db.inviteToken.findUnique({ where: { id: tokenRow.id } });

console.log("");
console.log(
  createdUser
    ? `✅ user created: ${createdUser.name} role=${createdUser.role}`
    : "❌ user not in DB after accept"
);
console.log(
  tokenAfter?.usedAt
    ? `✅ token marked used at ${tokenAfter.usedAt.toISOString()}`
    : "❌ token not marked used"
);

/* ── 5. Re-accept should fail (single-use) ────────────────────────────── */
await recipientPage.goto(inviteUrl, { waitUntil: "networkidle2" });
const reuseHeading = await recipientPage.evaluate(() =>
  document.querySelector("h1")?.textContent?.trim()
);
const reuseRejected = /already been used/i.test(reuseHeading ?? "");
console.log(
  reuseRejected
    ? `✅ second visit rejected: "${reuseHeading}"`
    : `❌ second visit not rejected: "${reuseHeading}"`
);

/* ── Cleanup: drop the test user + token so the DB stays tidy ────────── */
if (createdUser) {
  await db.user.delete({ where: { id: createdUser.id } });
}
await db.inviteToken.delete({ where: { id: tokenRow.id } });

/* ── 6. Residue: this run's own rows, by address, not a global total ───── */
// Scoped to the address this run invented, so it cannot be confused by anything
// else writing to the workspace — which is what a before/after count of the
// whole table would have been.
const residueUser = await db.user.findUnique({ where: { email: inviteEmail } });
const residueTokens = await db.inviteToken.count({ where: { companyId, email: inviteEmail } });
const cleanedUp = residueUser === null && residueTokens === 0;
console.log(
  cleanedUp
    ? "✅ no residue: this run's user + token are gone"
    : `❌ residue left behind: user=${residueUser ? "present" : "gone"} tokens=${residueTokens}`
);
const afterUsers = await db.user.count({ where: { companyId } });
const afterTokens = await db.inviteToken.count({ where: { companyId } });
console.log(`DB after (${companyId}): users=${afterUsers} invite_tokens=${afterTokens}`);

const ok = isWelcome && !!createdUser && !!tokenAfter?.usedAt && reuseRejected && cleanedUp;
console.log("");
console.log(ok ? "✅ invite flow round-trip succeeded" : "❌ invite flow has failures");

await browser.close();
await db.$disconnect();
process.exit(ok ? 0 : 1);
