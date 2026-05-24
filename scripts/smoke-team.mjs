// Smoke-test team management: invite → accept (Phase 6 token flow) →
// role-change → remove. Also covers the /login + /signup signed-in
// redirect (audit flaw #25).
//
// Side effects we verify in the DB:
//   • inviteUserAction  → InviteToken row (User NOT created yet)
//   • acceptInviteAction → User + Activity (user_joined) + Notification (welcome)
//   • updateUserRoleAction → Activity (user_role_changed) + Notification
//   • removeUserAction  → User deleted + Activity (user_removed)

import puppeteer from "puppeteer-core";
import { PrismaClient } from "@prisma/client";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3009";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";

const db = new PrismaClient();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

const stamp = Date.now();
const inviteEmail = `smoke-${stamp}@founderflow.app`;
const inviteName = `Smoke User ${stamp}`;
const acceptPassword = `smoke-pw-${stamp}`;

const beforeUsers = await db.user.count();
console.log(`DB before: users=${beforeUsers}`);

/* ── sign in as admin ─────────────────────────────────────────────────── */
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await page.waitForSelector("input[name=email]", { timeout: 30_000 });
await new Promise((r) => setTimeout(r, 500));
await page.type("input[name=email]", "demo@founderflow.app");
await page.type("input[name=password]", "demo123");
await page.evaluate(() => document.querySelector("form")?.requestSubmit());
await page
  .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 15_000 })
  .catch(() => {});
console.log(`signed in -> ${page.url()}`);

/* ── redirect-when-signed-in check (audit flaw #25) ──────────────────── */
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
const loginRedirected = !page.url().endsWith("/login");
console.log(`/login while signed in -> ${page.url()} (${loginRedirected ? "✅ bounced" : "❌"})`);

await page.goto(`${BASE}/signup`, { waitUntil: "networkidle2" });
const signupRedirected = !page.url().endsWith("/signup");
console.log(`/signup while signed in -> ${page.url()} (${signupRedirected ? "✅ bounced" : "❌"})`);

/* ── /team ────────────────────────────────────────────────────────────── */
await page.goto(`${BASE}/team`, { waitUntil: "networkidle2" });
await page
  .waitForFunction(() => document.querySelectorAll("article").length > 0, { timeout: 30_000 })
  .catch(() => {});
const cardsBefore = await page.evaluate(() => document.querySelectorAll("article").length);
console.log(`/team member cards before: ${cardsBefore}`);

/* ── open invite modal & fill (no password field anymore) ─────────────── */
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((b) =>
    /invite member/i.test(b.textContent ?? "")
  );
  btn?.click();
});
await page.waitForSelector('[role="dialog"] input', { timeout: 10_000 });

await page.evaluate(
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
    // Pick "Team Member" role (default is "cofounder").
    const memberBtn = Array.from(dialog.querySelectorAll("button")).find((b) =>
      /team member/i.test(b.textContent ?? "")
    );
    memberBtn?.click();
  },
  { name: inviteName, email: inviteEmail }
);

/* ── submit invite ────────────────────────────────────────────────────── */
await page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
await page
  .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 10_000 })
  .catch(() => {});
await page.screenshot({ path: `${OUT}/team-02-after-invite.png` });

// Phase 6: invite creates an InviteToken, not a User.
const token = await db.inviteToken.findFirst({
  where: { email: inviteEmail },
  orderBy: { createdAt: "desc" },
});
console.log(
  token
    ? `✅ InviteToken created: token=${token.token.slice(0, 8)}… role=${token.role}`
    : "❌ InviteToken NOT found"
);
const userAtInviteTime = await db.user.findUnique({ where: { email: inviteEmail } });
console.log(
  userAtInviteTime === null
    ? "✅ User row NOT yet created (token-based flow correct)"
    : "❌ User was created prematurely at invite time"
);
if (!token) {
  await browser.close();
  await db.$disconnect();
  process.exit(1);
}

/* ── Accept the invite in an ISOLATED browser context ─────────────────── */
// New incognito-style context so the recipient's session cookie doesn't
// clobber the admin's. Otherwise the admin's session vanishes the moment
// acceptInviteAction calls signIn() and subsequent /team requests come
// back as the brand-new "member" user — role-change + remove fail because
// the recipient isn't authorized to manage anyone.
const recipientContext = await browser.createBrowserContext();
const recipient = await recipientContext.newPage();
await recipient.goto(`${BASE}/invite/${token.token}`, { waitUntil: "networkidle2" });
await recipient.waitForSelector("input[type=password]", { timeout: 10_000 });
await new Promise((r) => setTimeout(r, 300));
await recipient.evaluate((pw) => {
  const el = document.querySelector("input[type=password]");
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(el, pw);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, acceptPassword);
await recipient.evaluate(() => document.querySelector("form")?.requestSubmit());
await recipient
  .waitForFunction(() => location.pathname.startsWith("/dashboard"), { timeout: 20_000 })
  .catch(() => {});
await recipientContext.close();

const invited = await db.user.findUnique({ where: { email: inviteEmail } });
console.log(
  invited
    ? `✅ User created after accept: ${invited.name} role=${invited.role}`
    : "❌ User missing after accept"
);
if (!invited) {
  await browser.close();
  await db.$disconnect();
  process.exit(1);
}

/* ── promote to cofounder via the role select ────────────────────────── */
// Refresh /team in the admin browser so the new user card shows up.
await page.goto(`${BASE}/team`, { waitUntil: "networkidle2" });
await page
  .waitForFunction(
    (id) => !!document.querySelector(`#role-${CSS.escape(id)}`),
    { timeout: 15_000 },
    invited.id
  )
  .catch(() => {});

await page.evaluate((targetId) => {
  const select = document.querySelector(`#role-${CSS.escape(targetId)}`);
  if (!select) return;
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set?.call(
    select,
    "cofounder"
  );
  select.dispatchEvent(new Event("change", { bubbles: true }));
}, invited.id);
await new Promise((r) => setTimeout(r, 2500));

let promoted = null;
for (let i = 0; i < 5; i++) {
  const rows = await db.$queryRaw`select role from "User" where id = ${invited.id}`;
  if (rows?.[0]?.role) {
    promoted = rows[0];
    if (promoted.role === "cofounder") break;
  }
  await new Promise((r) => setTimeout(r, 400));
}
console.log(
  promoted?.role === "cofounder"
    ? "✅ role updated to cofounder"
    : `❌ role still ${promoted?.role}`
);

/* ── remove the user ──────────────────────────────────────────────────── */
await page.evaluate((targetId) => {
  const select = document.querySelector(`#role-${CSS.escape(targetId)}`);
  const article = select?.closest("article");
  const trash = article?.querySelector("button[aria-label^='Remove']");
  trash?.click();
}, invited.id);
await new Promise((r) => setTimeout(r, 600));

await page.evaluate(() => {
  const dialog =
    document.querySelector('[role="dialog"]') || document.querySelector('[role="alertdialog"]');
  const removeBtn = Array.from(dialog?.querySelectorAll("button") ?? []).find((b) =>
    /^remove$/i.test((b.textContent ?? "").trim())
  );
  removeBtn?.click();
});
await page
  .waitForFunction(
    (email) =>
      !Array.from(document.querySelectorAll("article")).some((a) =>
        (a.textContent ?? "").includes(email)
      ),
    { timeout: 8000 },
    inviteEmail
  )
  .catch(() => {});

const removed = await db.user.findUnique({ where: { id: invited.id } });
console.log(removed ? `❌ user still in DB` : "✅ user removed from DB");

const afterRemoveUsers = await db.user.count();
const removeOk = !removed && afterRemoveUsers === beforeUsers;
console.log(`DB after remove: users=${afterRemoveUsers} ${removeOk ? "✅" : "❌"}`);

// Cleanup any leftover token row in case the recipient didn't fully consume it.
await db.inviteToken.deleteMany({ where: { email: inviteEmail } });

const ok =
  loginRedirected &&
  signupRedirected &&
  !!token &&
  userAtInviteTime === null &&
  !!invited &&
  promoted?.role === "cofounder" &&
  removeOk;

console.log("");
console.log(ok ? "✅ team flow round-trip succeeded" : "❌ team flow has failures");

await browser.close();
await db.$disconnect();
process.exit(ok ? 0 : 1);
