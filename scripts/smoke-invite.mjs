// Smoke-test Phase 6 (email-invite slice): full round-trip from admin
// invite → token landed in DB → recipient visits /invite/[token] → sets
// password → auto-signed-in.
//
// In dev (no RESEND_API_KEY) the action returns the invite URL directly,
// so we don't need to scrape a mailbox.

import puppeteer from "puppeteer-core";
import { PrismaClient } from "@prisma/client";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3009";

const db = new PrismaClient();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--disable-gpu"],
});

const stamp = Date.now();
const inviteEmail = `invite-${stamp}@founderflow.app`;
const inviteName = `Invite Test ${stamp}`;
const newPassword = `claim-${stamp}`;

const beforeUsers = await db.user.count();
const beforeTokens = await db.inviteToken.count();
console.log(`DB before: users=${beforeUsers} invite_tokens=${beforeTokens}`);

/* ── 1. Admin logs in + sends the invite ──────────────────────────────── */
const adminPage = await browser.newPage();
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
  where: { email: inviteEmail },
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

const ok = isWelcome && !!createdUser && !!tokenAfter?.usedAt && reuseRejected;
console.log("");
console.log(ok ? "✅ invite flow round-trip succeeded" : "❌ invite flow has failures");

await browser.close();
await db.$disconnect();
process.exit(ok ? 0 : 1);
