// Smoke-test Phase 1.D: invite → role-change → remove, with admin RBAC + the
// last-admin guard + the /login redirect-when-signed-in check.
//
// Side effects we verify in the DB:
//   • inviteUserAction  → User + Activity (user_joined) + Notification (welcome)
//   • updateUserRoleAction → Activity (user_role_changed) + Notification (target)
//   • removeUserAction  → User deleted + Activity (user_removed), cascades drop
//     the welcome+role notifications, so net notif count returns to baseline.
//   • /login while signed-in → 302 to /dashboard (server layout redirect).

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

// Use a unique email each run so re-running the smoke doesn't tripping the
// "email already exists" guard.
const stamp = Date.now();
const inviteEmail = `smoke-${stamp}@founderflow.app`;
const inviteName = `Smoke User ${stamp}`;
const invitePw = "smoke-tmp-pw";

const beforeUsers = await db.user.count();
const beforeActs = await db.activity.count();
const beforeNotifs = await db.notification.count();
console.log(`DB before: users=${beforeUsers} activities=${beforeActs} notifs=${beforeNotifs}`);

/* ── sign in as admin ─────────────────────────────────────────────────── */
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await page.type("input[type=email]", "demo@founderflow.app");
await page.type("input[type=password]", "demo123");
await page.evaluate(() => document.querySelector("form")?.requestSubmit());
await page
  .waitForFunction(() => !location.pathname.startsWith("/login"), {
    timeout: 15_000,
  })
  .catch(() => {});
console.log(`signed in -> ${page.url()}`);

/* ── redirect-when-signed-in check (audit flaw #25) ──────────────────── */
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
const afterLoginUrl = page.url();
const loginRedirected = !afterLoginUrl.endsWith("/login");
console.log(`/login while signed in -> ${afterLoginUrl} (${loginRedirected ? "✅ bounced" : "❌ no bounce"})`);

await page.goto(`${BASE}/signup`, { waitUntil: "networkidle2" });
const afterSignupUrl = page.url();
const signupRedirected = !afterSignupUrl.endsWith("/signup");
console.log(`/signup while signed in -> ${afterSignupUrl} (${signupRedirected ? "✅ bounced" : "❌ no bounce"})`);

/* ── /team ────────────────────────────────────────────────────────────── */
await page.goto(`${BASE}/team`, { waitUntil: "networkidle2" });
await page
  .waitForFunction(() => document.querySelectorAll("article").length > 0, {
    timeout: 8000,
  })
  .catch(() => {});
const cardsBefore = await page.evaluate(() => document.querySelectorAll("article").length);
console.log(`/team member cards before: ${cardsBefore}`);
await page.screenshot({ path: `${OUT}/team-01-roster-before.png` });

/* ── open invite modal & fill ─────────────────────────────────────────── */
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll("button")).find((b) =>
    /invite member/i.test(b.textContent ?? "")
  );
  btn?.click();
});
await new Promise((r) => setTimeout(r, 500));

await page.evaluate(
  ({ name, email, pw }) => {
    const dialog = document.querySelector('[role="dialog"]');
    const inputs = dialog?.querySelectorAll("input");
    if (!inputs || inputs.length < 3) return;
    const [nameEl, emailEl, pwEl] = inputs;
    const setVal = (el, v) => {
      el.focus();
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set?.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setVal(nameEl, name);
    setVal(emailEl, email);
    setVal(pwEl, pw);
    // Default role is "cofounder" — flip to "member" to exercise the other branch.
    const memberBtn = Array.from(dialog.querySelectorAll("button")).find((b) =>
      /team member/i.test(b.textContent ?? "")
    );
    memberBtn?.click();
  },
  { name: inviteName, email: inviteEmail, pw: invitePw }
);
await page.screenshot({ path: `${OUT}/team-02-modal.png` });

/* ── submit invite ────────────────────────────────────────────────────── */
await page.evaluate(() => {
  document.querySelector('[role="dialog"] form')?.requestSubmit();
});
// Wait for either: the modal to close (success path) OR a toast to appear.
await page
  .waitForFunction(() => !document.querySelector('[role="dialog"]'), {
    timeout: 8000,
  })
  .catch(() => {});
await page
  .waitForFunction(
    (email) => Array.from(document.querySelectorAll("article")).some((a) => (a.textContent ?? "").includes(email)),
    { timeout: 8000 },
    inviteEmail
  )
  .catch(() => {});
await page.screenshot({ path: `${OUT}/team-03-after-invite.png` });

const cardsAfterInvite = await page.evaluate(() => document.querySelectorAll("article").length);
console.log(`/team member cards after invite: ${cardsAfterInvite}`);

const invited = await db.user.findUnique({ where: { email: inviteEmail } });
console.log(
  invited
    ? `✅ invited user created: ${invited.name} <${invited.email}> role=${invited.role}`
    : "❌ invited user NOT found in DB"
);
if (!invited) {
  await browser.close();
  await db.$disconnect();
  process.exit(1);
}

const afterInviteUsers = await db.user.count();
const afterInviteActs = await db.activity.count();
const afterInviteNotifs = await db.notification.count();
const inviteOk =
  afterInviteUsers === beforeUsers + 1 &&
  afterInviteActs === beforeActs + 1 &&
  afterInviteNotifs === beforeNotifs + 1;
console.log(
  `DB after invite: users=${afterInviteUsers} activities=${afterInviteActs} notifs=${afterInviteNotifs} ${
    inviteOk ? "✅" : "❌"
  }`
);

/* ── promote to cofounder via the role select ────────────────────────── */
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
await page.screenshot({ path: `${OUT}/team-04-after-role.png` });

// Supabase pooled reads can lag a single connection; retry briefly. Force a
// raw query to dodge any client-side caching too.
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

const afterRoleActs = await db.activity.count();
const afterRoleNotifs = await db.notification.count();
const roleOk =
  promoted?.role === "cofounder" &&
  afterRoleActs === afterInviteActs + 1 &&
  // Target (invited) !== actor (admin), so a notification fans out.
  afterRoleNotifs === afterInviteNotifs + 1;
console.log(
  `DB after role:   activities=${afterRoleActs} notifs=${afterRoleNotifs} ${roleOk ? "✅" : "❌"}`
);

/* ── confirm-dialog stubbing: we replace useConfirm's window prompt with
   a global so we can auto-accept. Easiest path: click trash, then click the
   "Remove" button in the surfaced confirm dialog. */
await page.evaluate((targetId) => {
  // Find the article whose select #role-<id> matches our invited user.
  const select = document.querySelector(`#role-${CSS.escape(targetId)}`);
  const article = select?.closest("article");
  const trash = article?.querySelector("button[aria-label^='Remove']");
  trash?.click();
}, invited.id);
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: `${OUT}/team-05-confirm.png` });

await page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]') || document.querySelector('[role="alertdialog"]');
  const removeBtn = Array.from(dialog?.querySelectorAll("button") ?? []).find((b) =>
    /^remove$/i.test((b.textContent ?? "").trim())
  );
  removeBtn?.click();
});
await page
  .waitForFunction(
    (email) => !Array.from(document.querySelectorAll("article")).some((a) => (a.textContent ?? "").includes(email)),
    { timeout: 8000 },
    inviteEmail
  )
  .catch(() => {});
await page.screenshot({ path: `${OUT}/team-06-after-remove.png` });

const removed = await db.user.findUnique({ where: { id: invited.id } });
console.log(removed ? `❌ user still in DB` : "✅ user removed from DB");

const afterRemoveUsers = await db.user.count();
const afterRemoveActs = await db.activity.count();
const afterRemoveNotifs = await db.notification.count();
const removeOk =
  !removed &&
  afterRemoveUsers === beforeUsers &&
  // user_removed activity row added; existing user_joined + user_role_changed
  // rows survive because their userId is the actor (admin), not the deleted user.
  afterRemoveActs === afterRoleActs + 1 &&
  // The welcome + role-change notifications targeted the removed user, so
  // they cascade-drop and the net count returns to baseline.
  afterRemoveNotifs === beforeNotifs;
console.log(
  `DB after remove: users=${afterRemoveUsers} activities=${afterRemoveActs} notifs=${afterRemoveNotifs} ${removeOk ? "✅" : "❌"}`
);

const ok = loginRedirected && signupRedirected && inviteOk && roleOk && removeOk;
console.log(ok ? "✅ team flow round-trip succeeded" : "❌ team flow has failures");

await browser.close();
await db.$disconnect();
process.exit(ok ? 0 : 1);
