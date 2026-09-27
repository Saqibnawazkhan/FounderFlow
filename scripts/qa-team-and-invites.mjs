/*
 * QA EXERCISE SCRIPT — domain: team-and-invites  (AGENT_INDEX = 10)
 * Authored in Phase 1 (static). Phase 2 runs it to promote each `static`
 * finding to `observed`.
 *
 * Surface under test:
 *   /team, lib/actions/team.ts (invite / resend / revoke / role change /
 *   deactivate / reactivate / acceptInviteAction), lib/queries/users.ts,
 *   app/invite/[token], the free-plan member cap in lib/billing/plan.ts.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DATA SAFETY — the hardest rule in this audit.
 *
 * This script NEVER writes a row it did not create. It signs up its OWN
 * workspaces through the real /signup flow, every tenant name starts with
 * `qa-` so scripts/_qa-guard.mjs sweep can find it, and EVERY database
 * assertion carries `where: { companyId: <one of MY tenant ids> }`. There is
 * not a single bare `db.X.count()` in this file: under concurrency another
 * agent's insert could satisfy a global "did mine land?" check and produce a
 * FALSE PASS, which is the most expensive outcome in a pre-launch audit.
 *
 * The three direct writes this script makes to rows it did not create through
 * the UI are all to ITS OWN tenants, and each says why at the call site:
 *   1. `company.plan = "team"` on tenant A, to stop the free cap blocking the
 *      later blocks once the cap itself has been measured.
 *   2. `inviteToken.expiresAt` into the past on tenant P, to age an invite
 *      without sleeping seven days.
 *   3. The softDeleteWorkspace simulation on tenant W (Company + its Users
 *      tombstoned), which mirrors lib/actions/account.ts exactly.
 * No seeded row (demo-nimbus or otherwise) is read-asserted or written.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Conventions copied from scripts/smoke-chat.mjs:
 *   - localDb() only. A bare `new PrismaClient()` auto-loads the root .env,
 *     which points at PRODUCTION Supabase.
 *   - ok()/fail() with process.exitCode; fail() never throws, so one run
 *     reports every broken assertion. A literal ❌ is printed on failure so
 *     the runner's summary counts it.
 *   - The retry-until-hydrated signIn helper, verbatim (FaultsAudit A14).
 *   - State predicates via waitForFunction, never a fixed setTimeout.
 */

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

/* Per-agent screenshot directory. A shared fixed filename destroys evidence. */
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/team-and-invites";
mkdirSync(OUT, { recursive: true });

const STAMP = Date.now().toString().slice(-8);

/**
 * AGENT_INDEX 10 → x-real-ip 10.99.0.10.
 *
 * WHY EVERY CONTEXT GETS ITS OWN STRING. getClientIp() falls back to the
 * literal "unknown" in dev, so without this header every agent shares ONE
 * limiters.auth bucket (5 per 60s) fed by nine call sites and we starve each
 * other into false "cannot sign in" bugs. This script performs five signups
 * and several logins, which alone would exhaust a single 5/60s bucket — so
 * each browser context gets a DISTINCT suffix inside this agent's own lane.
 * The limiter keys on the raw header string, so `10.99.0.10-b` is a separate
 * bucket that still reads unmistakably as agent 10's.
 */
const IP = (suffix) => (suffix ? `10.99.0.10-${suffix}` : "10.99.0.10");

/** Mirrors lib/billing/plan.ts. A free workspace allows this many ACTIVE users. */
const FREE_MEMBER_LIMIT = 2;

const db = localDb();

/** Tenant ids this run created. Everything here is torn down in `finally`. */
const myTenants = [];

let passes = 0;
function ok(label) {
  passes += 1;
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  console.error(`  ❌  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

/* ───────────────────────────── helpers ─────────────────────────────────── */

function wire(page, tag) {
  page.on("pageerror", (e) => console.error(`PAGEERROR[${tag}]:`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`CONSOLE.error[${tag}]:`, m.text());
  });
}

/** A fresh browser context with its own cookie jar and its own rate-limit key. */
async function newCtx(browser, tag, ipSuffix) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  wire(page, tag);
  // BEFORE the first navigation, per the audit brief.
  await page.setExtraHTTPHeaders({ "x-real-ip": IP(ipSuffix) });
  return { ctx, page };
}

/**
 * Sign in. Copied verbatim from scripts/smoke-chat.mjs.
 *
 * On a cold dev server the form paints before React hydrates; a click that
 * lands first performs a NATIVE submit, which (the form declares no method)
 * becomes a GET with the credentials in the query string and no sign-in.
 * Retry until React owns the click. Tracked as FaultsAudit A14.
 */
async function signIn(page, email, password) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector("input[type=email]", { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.type("input[type=email]", email);
    await page.type("input[type=password]", password);
    await page.click("button[type=submit]");
    const left = await page
      .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (left) {
      await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 5000 }).catch(() => {});
      return;
    }
  }
  throw new Error(`could not sign in as ${email} after 3 attempts`);
}

/**
 * Create one of THIS AGENT'S tenants through the real /signup flow.
 *
 * Two-step form: both steps are in the DOM at all times (step 2 is
 * `hidden`), so the Continue button has to be clicked before the company
 * fields are reachable. The submit button is inert until `useHydrated()`
 * flips, which is the same A14 window signIn retries around — so the wait is
 * on the button's own disabled state, not on a clock.
 *
 * Returns { companyId, email, password, companyName } with companyId resolved
 * by the OWNER'S EMAIL, never by "the newest company": another agent signing
 * up in the same second would otherwise hand us their tenant id and every
 * later assertion would be scoped to somebody else's data.
 */
async function signUpTenant(page, slug) {
  const companyName = `qa-${slug}-${STAMP}`;
  const email = `qa-${slug}-${STAMP}@founderflow.test`;
  const password = `QaAudit${STAMP}!a`;
  const name = `QA ${slug} ${STAMP}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
    await page.waitForSelector('input[name="name"]', { timeout: 30000 });
    // Hydration gate: the step-2 submit button is disabled until useHydrated().
    await page
      .waitForFunction(
        () => {
          const b = document.querySelector('form button[type="submit"]');
          return !b || !b.disabled;
        },
        { timeout: 30000 }
      )
      .catch(() => {});

    await page.type('input[name="name"]', name);
    await page.type('input[name="email"]', email);
    await page.type('input[name="password"]', password);

    const advanced = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("form button[type=button]")].find((b) =>
        /continue/i.test(b.textContent ?? "")
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!advanced) continue;

    // Step 2 is visible once the company input has a layout box.
    const onStep2 = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('input[name="companyName"]');
          return !!el && el.offsetParent !== null;
        },
        { timeout: 15000 }
      )
      .then(() => true)
      .catch(() => false);
    if (!onStep2) continue;

    await page.type('input[name="companyName"]', companyName);
    // industry + currency carry RHF defaultValues (INDUSTRIES[0] / "PKR").
    await page.click('form button[type="submit"]');

    const landed = await page
      .waitForFunction(() => location.pathname.startsWith("/dashboard"), { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (landed) break;
    if (attempt === 3) throw new Error(`signup failed for ${companyName}: ${page.url()}`);
  }

  const owner = await db.user.findUnique({ where: { email }, select: { companyId: true } });
  if (!owner) throw new Error(`signup produced no user row for ${email}`);
  myTenants.push(owner.companyId);
  return { companyId: owner.companyId, email, password, companyName, name };
}

/** Land on /team and wait for the roster cards (RSC + loading.tsx skeleton). */
async function gotoTeam(page) {
  await page.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
  await page
    .waitForFunction(() => document.querySelectorAll("article").length > 0, { timeout: 30000 })
    .catch(() => {});
}

/** Drive the invite modal. Returns the toast text the action produced. */
async function submitInvite(page, { name, email, role }) {
  await gotoTeam(page);
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /invite member/i.test(b.textContent ?? "")
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) throw new Error("no 'Invite member' button on /team");
  await page.waitForSelector('[role="dialog"] input', { timeout: 15000 });

  await page.evaluate(
    ({ n, e, r }) => {
      const dialog = document.querySelector('[role="dialog"]');
      const inputs = dialog.querySelectorAll("input");
      const setVal = (el, v) => {
        el.focus();
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      setVal(inputs[0], n);
      setVal(inputs[1], e);
      // Role is a pair of aria-pressed buttons, not a <select>.
      const roleBtn = [...dialog.querySelectorAll("button[aria-pressed]")].find((b) =>
        r === "cofounder"
          ? /co-founder/i.test(b.textContent ?? "")
          : /team member/i.test(b.textContent ?? "")
      );
      roleBtn?.click();
    },
    { n: name, e: email, r: role }
  );

  await page.evaluate(() => document.querySelector('[role="dialog"] form').requestSubmit());
  // Either the modal closes (success) or a toast appears (failure). Wait on
  // whichever settles first — never on a clock.
  await page
    .waitForFunction(
      () =>
        !document.querySelector('[role="dialog"]') ||
        document.querySelectorAll('[role="status"]').length > 0,
      { timeout: 20000 }
    )
    .catch(() => {});
  const toast = await page.evaluate(() =>
    [...document.querySelectorAll('[role="status"]')].map((t) => t.innerText).join(" | ")
  );
  // Close the modal if it is still up so the next interaction is not blocked.
  await page.keyboard.press("Escape").catch(() => {});
  return toast;
}

/** Click a confirm-dialog button by its label, e.g. "Deactivate" / "Make admin". */
async function confirmDialog(page, label) {
  await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
  const clicked = await page.evaluate((l) => {
    const dialog = document.querySelector('[role="dialog"]');
    const btn = [...dialog.querySelectorAll("button")].find((b) =>
      new RegExp(l, "i").test(b.textContent ?? "")
    );
    if (!btn) return false;
    btn.click();
    return true;
  }, label);
  if (!clicked) throw new Error(`no "${label}" button in the confirm dialog`);
  await page
    .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 15000 })
    .catch(() => {});
}

/** Set the password on /invite/[token] and submit. Returns the final URL. */
async function acceptInvite(page, token, password) {
  await page.goto(`${BASE}/invite/${token}`, { waitUntil: "networkidle0", timeout: 60000 });
  const hasForm = await page.$("input[type=password]");
  if (!hasForm) return { accepted: false, url: page.url(), heading: await headingOf(page) };
  // The submit button is inert until hydration (A14) — wait on that, not a clock.
  await page
    .waitForFunction(
      () => {
        const b = document.querySelector('form button[type="submit"]');
        return !!b && !b.disabled;
      },
      { timeout: 30000 }
    )
    .catch(() => {});
  await page.type("input[type=password]", password);
  await page.click('form button[type="submit"]');
  const landed = await page
    .waitForFunction(
      () =>
        location.pathname.startsWith("/dashboard") ||
        location.pathname.startsWith("/tasks") ||
        document.querySelectorAll('[role="status"]').length > 0,
      { timeout: 30000 }
    )
    .then(() => true)
    .catch(() => false);
  const toast = await page.evaluate(() =>
    [...document.querySelectorAll('[role="status"]')].map((t) => t.innerText).join(" | ")
  );
  return { accepted: landed, url: page.url(), toast };
}

async function headingOf(page) {
  return page.evaluate(() => document.querySelector("h1")?.textContent?.trim() ?? "");
}

/** The most recent pending invite for an email IN ONE OF MY TENANTS. */
async function inviteRow(companyId, email) {
  return db.inviteToken.findFirst({
    where: { companyId, email },
    orderBy: { createdAt: "desc" },
  });
}

/** Active (non-tombstoned) user count for ONE of my tenants. */
function activeUsers(companyId) {
  return db.user.count({ where: { companyId, deletedAt: null } });
}

/** Run a block; a throw inside it becomes a FAIL, never a dead run. */
async function block(title, fn) {
  console.log(`\n── ${title} ──`);
  try {
    await fn();
  } catch (e) {
    fail(title, e.message);
  }
}

/* ────────────────────────────── the run ────────────────────────────────── */

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });
  console.log("== team-and-invites QA (agent 10) ==");

  let admin, adminCtx, A;

  try {
    /* ══ SETUP: this agent's primary tenant ═══════════════════════════════ */
    ({ ctx: adminCtx, page: admin } = await newCtx(browser, "admin"));
    A = await signUpTenant(admin, "team");
    console.log(`  ..  tenant A = ${A.companyName} (${A.companyId})`);

    const planRow = await db.company.findUnique({
      where: { id: A.companyId },
      select: { plan: true, ownerId: true },
    });
    if (planRow?.plan === "free") ok("a brand-new workspace lands on the free plan");
    else fail("new workspace plan", `expected "free", got "${planRow?.plan}"`);

    /* ══ ti-008 — invite role choices never include admin ═════════════════ */
    await block("invite modal role choices", async () => {
      await gotoTeam(admin);
      await admin.evaluate(() => {
        [...document.querySelectorAll("button")]
          .find((b) => /invite member/i.test(b.textContent ?? ""))
          ?.click();
      });
      await admin.waitForSelector('[role="dialog"] input', { timeout: 15000 });
      const roles = await admin.evaluate(() =>
        [...document.querySelectorAll('[role="dialog"] button[aria-pressed]')].map((b) =>
          b.innerText.split("\n")[0].trim()
        )
      );
      await admin.screenshot({ path: `${OUT}/01-invite-modal-${STAMP}.png` });
      await admin.keyboard.press("Escape");
      if (roles.length === 2 && !roles.some((r) => /admin/i.test(r))) {
        ok(`invite offers exactly ${JSON.stringify(roles)} — no admin option`);
      } else {
        fail("invite role choices", JSON.stringify(roles));
      }
    });

    /* ══ happy path: invite → token → accept → handle + #general ══════════ */
    const bEmail = `qa-team-b-${STAMP}@founderflow.test`;
    const invitePw = `QaInvite${STAMP}!b`;
    let bCtx, bPage;

    await block("invite → accept round trip", async () => {
      const toast = await submitInvite(admin, {
        name: `QA Bee ${STAMP}`,
        email: bEmail,
        role: "cofounder",
      });
      const row = await inviteRow(A.companyId, bEmail);
      if (row && row.role === "cofounder" && row.usedAt === null) {
        ok(`invite row created in MY tenant (role=${row.role}, unused)`);
      } else {
        return fail("invite row", `toast="${toast}" row=${JSON.stringify(row)}`);
      }
      const days = Math.round((row.expiresAt - row.createdAt) / 86400000);
      if (days === 7) ok("invite expires in 7 days, as the modal promises");
      else fail("invite expiry", `expected 7 days, got ${days}`);

      // The invitee, in their own context and their own rate-limit bucket.
      ({ ctx: bCtx, page: bPage } = await newCtx(browser, "invitee-b", "b"));
      await bPage.goto(`${BASE}/invite/${row.token}`, { waitUntil: "networkidle0" });
      const heading = await headingOf(bPage);
      if (/welcome to/i.test(heading) && heading.includes(A.companyName)) {
        ok(`invite page names MY workspace: "${heading}"`);
      } else {
        fail("invite page heading", heading);
      }
      await bPage.screenshot({ path: `${OUT}/02-invite-landing-${STAMP}.png` });

      const res = await acceptInvite(bPage, row.token, invitePw);
      if (res.accepted && /\/dashboard/.test(res.url)) ok("invitee auto-signed-in to /dashboard");
      else fail("invite accept", `url=${res.url} toast=${res.toast}`);

      const b = await db.user.findFirst({ where: { companyId: A.companyId, email: bEmail } });
      if (b && b.role === "cofounder" && b.deletedAt === null) {
        ok("the new teammate is in MY tenant with the invited role");
      } else {
        return fail("accepted user row", JSON.stringify(b));
      }
      // ti-009: handle assignment on acceptance (FaultsAudit T16's runtime half).
      if (b.handle) ok(`invitee got an @mention handle: @${b.handle}`);
      else fail("invitee handle", "handle is NULL — the teammate is unmentionable");

      const seat = await db.channelMember.count({
        where: { userId: b.id, channel: { companyId: A.companyId, slug: "general" } },
      });
      if (seat === 1) ok("invitee was joined to #general");
      else fail("#general membership", `expected 1 membership row, found ${seat}`);

      const used = await db.inviteToken.findUnique({ where: { id: row.id } });
      if (used?.usedAt) ok("the token is burnt (usedAt set)");
      else fail("token burn", JSON.stringify(used));
    });

    /* ══ ti-002 — free-plan cap vs. the landing page's promise ════════════ */
    await block("free-plan cap wording", async () => {
      const before = await activeUsers(A.companyId);
      const toast = await submitInvite(admin, {
        name: `QA Cee ${STAMP}`,
        email: `qa-team-c-${STAMP}@founderflow.test`,
        role: "member",
      });
      const created = await inviteRow(A.companyId, `qa-team-c-${STAMP}@founderflow.test`);
      if (created) {
        fail(
          "free cap not enforced",
          `2 active users already; a 3rd invite was still created in ${A.companyId}`
        );
      } else if (/limited to 2 members/i.test(toast)) {
        ok(`cap refuses the 2nd teammate at ${before} active users: "${toast.trim()}"`);
        // The landing page sells "1 workspace, up to 2 teammates" (app/page.tsx:875),
        // which reads as founder + 2 = 3 users. Enforcement is 2 users TOTAL.
        fail(
          "ti-002 pricing copy vs enforcement",
          'landing says "up to 2 teammates" but the founder + 1 teammate already trips the cap'
        );
      } else {
        fail("free cap message", `unexpected toast: "${toast}"`);
      }
      await admin.screenshot({ path: `${OUT}/03-cap-toast-${STAMP}.png` });
    });

    /* ══ ti-003 — reactivate bypasses the cap entirely ════════════════════ */
    await block("free-plan cap vs reactivate", async () => {
      // Deactivate B → a seat frees up.
      await gotoTeam(admin);
      await admin.evaluate((n) => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          new RegExp(`Deactivate ${n}`, "i").test(b.getAttribute("aria-label") ?? "")
        );
        btn?.click();
      }, `QA Bee ${STAMP}`);
      await confirmDialog(admin, "Deactivate");
      await admin
        .waitForFunction(
          (e) => !document.body.innerText.includes(e),
          { timeout: 20000 },
          bEmail
        )
        .catch(() => {});
      const bRow = await db.user.findFirst({ where: { companyId: A.companyId, email: bEmail } });
      if (bRow?.deletedAt) ok("deactivate writes the tombstone, not a hard delete");
      else fail("deactivate", JSON.stringify(bRow));

      // With a seat free, invite + accept C.
      const cEmail = `qa-team-c2-${STAMP}@founderflow.test`;
      await submitInvite(admin, { name: `QA Cee2 ${STAMP}`, email: cEmail, role: "member" });
      const cRow = await inviteRow(A.companyId, cEmail);
      if (!cRow) return fail("invite after deactivate", "no invite row; the seat did not free up");
      ok("deactivating a teammate frees a free-plan seat");

      const { ctx: cCtx, page: cPage } = await newCtx(browser, "invitee-c", "c");
      await acceptInvite(cPage, cRow.token, `QaInvite${STAMP}!c`);
      await cPage.close();
      await cCtx.close();

      // Now reactivate B. NOTHING re-checks the cap on this path:
      // memberLimitForPlan() is called in exactly one place, inviteUserAction.
      await gotoTeam(admin);
      const reactivated = await admin.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /reactivate/i.test(b.textContent ?? "")
        );
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!reactivated) return fail("reactivate control", "no Reactivate button on /team");
      await admin
        .waitForFunction(
          (e) => document.body.innerText.includes(e),
          { timeout: 20000 },
          bEmail
        )
        .catch(() => {});

      const total = await activeUsers(A.companyId);
      if (total > FREE_MEMBER_LIMIT) {
        fail(
          "ti-003 free-plan cap bypass",
          `tenant ${A.companyId} now has ${total} ACTIVE users on plan=free (limit ${FREE_MEMBER_LIMIT})`
        );
        await admin.screenshot({ path: `${OUT}/04-cap-bypassed-${STAMP}.png` });
      } else {
        ok(`reactivate respects the cap (${total} active users)`);
      }
    });

    /* From here the cap is measured and only gets in the way. Lift it on MY
     * OWN tenant — the same column the LemonSqueezy webhook writes. */
    await db.company.update({ where: { id: A.companyId }, data: { plan: "team" } });

    /* ══ ti-010 / ti-011 — resend rotates, revoke kills ═══════════════════ */
    await block("resend rotates the link, revoke kills it", async () => {
      const dEmail = `qa-team-d-${STAMP}@founderflow.test`;
      await submitInvite(admin, { name: `QA Dee ${STAMP}`, email: dEmail, role: "member" });
      const first = await inviteRow(A.companyId, dEmail);
      if (!first) return fail("invite for resend test", "no row");

      await gotoTeam(admin);
      await admin.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /^resend$/i.test((b.textContent ?? "").trim())
        );
        btn?.click();
      });
      await admin
        .waitForFunction(() => document.querySelectorAll('[role="status"]').length > 0, {
          timeout: 20000,
        })
        .catch(() => {});
      const second = await db.inviteToken.findUnique({ where: { id: first.id } });
      if (second && second.token !== first.token) ok("resend rotates the token");
      else fail("resend rotation", "token unchanged — an old forwarded link still works");
      if (second && second.expiresAt > first.expiresAt) ok("resend pushes the expiry out");
      else fail("resend expiry", `${first.expiresAt} → ${second?.expiresAt}`);

      // The OLD link must be dead.
      const { ctx: oldCtx, page: oldPage } = await newCtx(browser, "old-link", "d");
      await oldPage.goto(`${BASE}/invite/${first.token}`, { waitUntil: "networkidle0" });
      const oldHeading = await headingOf(oldPage);
      if (/invalid/i.test(oldHeading)) ok("the pre-resend link is dead");
      else fail("stale invite link", `expected the invalid state, got "${oldHeading}"`);

      // Revoke.
      await gotoTeam(admin);
      await admin.evaluate((n) => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          new RegExp(`Revoke ${n}`, "i").test(b.getAttribute("aria-label") ?? "")
        );
        btn?.click();
      }, `QA Dee ${STAMP}`);
      await confirmDialog(admin, "Revoke");
      await admin
        .waitForFunction((e) => !document.body.innerText.includes(e), { timeout: 20000 }, dEmail)
        .catch(() => {});
      const gone = await db.inviteToken.count({ where: { companyId: A.companyId, email: dEmail } });
      if (gone === 0) ok("revoke hard-deletes the invite in MY tenant");
      else fail("revoke", `${gone} invite row(s) survive`);

      await oldPage.goto(`${BASE}/invite/${second.token}`, { waitUntil: "networkidle0" });
      const revokedHeading = await headingOf(oldPage);
      if (/invalid/i.test(revokedHeading)) ok("the revoked link is dead immediately");
      else fail("revoked invite link", `got "${revokedHeading}"`);
      await oldPage.close();
      await oldCtx.close();
    });

    /* ══ ti-001 — does a role change actually take effect? ════════════════ */
    await block("role change vs. the live session", async () => {
      const eEmail = `qa-team-e-${STAMP}@founderflow.test`;
      const ePw = `QaInvite${STAMP}!e`;
      await submitInvite(admin, { name: `QA Eee ${STAMP}`, email: eEmail, role: "member" });
      const eRow = await inviteRow(A.companyId, eEmail);
      if (!eRow) return fail("member invite", "no row");

      const { ctx: eCtx, page: ePage } = await newCtx(browser, "member-e", "e");
      await acceptInvite(ePage, eRow.token, ePw);

      // Baseline: a member is bounced off every finance route.
      await ePage.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 });
      const memberLanding = new URL(ePage.url()).pathname;
      if (memberLanding !== "/dashboard") ok(`a member is bounced off /dashboard (→ ${memberLanding})`);
      else fail("member finance gate", "a member reached /dashboard");

      // A member's /team is read-only and leaks neither invites nor tombstones.
      await gotoTeam(ePage);
      const memberTeam = await ePage.evaluate(() => ({
        invite: [...document.querySelectorAll("button")].some((b) =>
          /invite member/i.test(b.textContent ?? "")
        ),
        selects: document.querySelectorAll('select[id^="role-"]').length,
        pending: /pending invites/i.test(document.body.innerText),
        deactivated: /^deactivated$/im.test(document.body.innerText),
      }));
      if (!memberTeam.invite && memberTeam.selects === 0) {
        ok("a member sees no invite button and no role control on /team");
      } else {
        fail("member /team controls", JSON.stringify(memberTeam));
      }
      if (!memberTeam.pending && !memberTeam.deactivated) {
        ok("a member sees neither the pending-invite nor the deactivated panel");
      } else {
        fail("member /team leak", JSON.stringify(memberTeam));
      }
      await ePage.screenshot({ path: `${OUT}/05-member-team-${STAMP}.png` });

      // PROMOTE member → cofounder, then re-check WITHOUT a new sign-in.
      const eUser = await db.user.findFirst({ where: { companyId: A.companyId, email: eEmail } });
      await gotoTeam(admin);
      await admin.evaluate((id) => {
        const sel = document.querySelector(`select#role-${id}`);
        if (!sel) return;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype,
          "value"
        ).set;
        setter.call(sel, "cofounder");
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }, eUser.id);
      await admin
        .waitForFunction(() => document.querySelectorAll('[role="status"]').length > 0, {
          timeout: 20000,
        })
        .catch(() => {});
      const promoted = await db.user.findFirst({
        where: { companyId: A.companyId, email: eEmail },
        select: { role: true },
      });
      if (promoted?.role === "cofounder") ok("the promotion landed in MY tenant's database");
      else fail("promotion persistence", JSON.stringify(promoted));

      await ePage.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 });
      const afterPromo = new URL(ePage.url()).pathname;
      if (afterPromo === "/dashboard") {
        ok("a promoted cofounder can reach /dashboard right away");
      } else {
        fail(
          "ti-001 promotion not honoured",
          `still bounced to ${afterPromo}; middleware reads the cookie role, and auth.config.ts's ` +
            "jwt callback never touches the database"
        );
      }

      // DEMOTE cofounder → member. This is the security-relevant direction.
      await gotoTeam(admin);
      await admin.evaluate((id) => {
        const sel = document.querySelector(`select#role-${id}`);
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype,
          "value"
        ).set;
        setter.call(sel, "member");
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }, eUser.id);
      await admin
        .waitForFunction(() => document.querySelectorAll('[role="status"]').length > 0, {
          timeout: 20000,
        })
        .catch(() => {});
      const demoted = await db.user.findFirst({
        where: { companyId: A.companyId, email: eEmail },
        select: { role: true, sessionVersion: true },
      });
      if (demoted?.role === "member") ok("the demotion landed in MY tenant's database");
      else fail("demotion persistence", JSON.stringify(demoted));

      await ePage.goto(`${BASE}/expenses`, { waitUntil: "networkidle0", timeout: 60000 });
      const afterDemo = new URL(ePage.url()).pathname;
      const sawMoney = await ePage.evaluate(() => /PKR|Rs\.?\s?\d/i.test(document.body.innerText));
      if (afterDemo !== "/expenses") {
        ok(`a demoted member loses /expenses immediately (→ ${afterDemo})`);
      } else {
        fail(
          "ti-001 demotion not honoured",
          `the demoted user still rendered /expenses (money on screen: ${sawMoney}). ` +
            "app/(app)/expenses/page.tsx calls requireScopedSession() but never canSeeFinances(); " +
            "the only member gate is middleware, which reads the stale cookie role"
        );
        await ePage.screenshot({ path: `${OUT}/06-demoted-still-on-expenses-${STAMP}.png` });
      }

      // WRITES, by contrast, re-read the role through auth() — they must refuse.
      await gotoTeam(ePage);
      const writeControls = await ePage.evaluate(
        () =>
          [...document.querySelectorAll("button")].some((b) =>
            /invite member/i.test(b.textContent ?? "")
          ) || document.querySelectorAll('select[id^="role-"]').length > 0
      );
      if (!writeControls) ok("a demoted user gets no team-write controls (server role is fresh)");
      else fail("demoted write controls", "invite / role controls still rendered");

      await ePage.close();
      await eCtx.close();
    });

    /* ══ double-accept: two tabs, one token ═══════════════════════════════ */
    await block("the same invite accepted twice", async () => {
      const fEmail = `qa-team-f-${STAMP}@founderflow.test`;
      const fPw = `QaInvite${STAMP}!f`;
      await submitInvite(admin, { name: `QA Eff ${STAMP}`, email: fEmail, role: "member" });
      const fRow = await inviteRow(A.companyId, fEmail);
      if (!fRow) return fail("invite for double-accept", "no row");

      const one = await newCtx(browser, "race-1", "f1");
      const two = await newCtx(browser, "race-2", "f2");
      const results = await Promise.allSettled([
        acceptInvite(one.page, fRow.token, fPw),
        acceptInvite(two.page, fRow.token, fPw),
      ]);

      const users = await db.user.count({ where: { companyId: A.companyId, email: fEmail } });
      if (users === 1) {
        ok("two simultaneous acceptances produced exactly ONE account");
      } else {
        fail("double-accept", `${users} user rows for ${fEmail} in MY tenant`);
      }
      const burnt = await db.inviteToken.findUnique({ where: { id: fRow.id } });
      if (burnt?.usedAt) ok("the token is burnt exactly once");
      else fail("double-accept token", JSON.stringify(burnt));
      console.log(
        `  ..  race outcomes: ${results.map((r) => (r.status === "fulfilled" ? r.value.url : r.reason?.message)).join(" | ")}`
      );

      // Replay the burnt link.
      await one.page.goto(`${BASE}/invite/${fRow.token}`, { waitUntil: "networkidle0" });
      const replay = await headingOf(one.page);
      if (/already been used/i.test(replay)) ok("replaying a burnt invite is refused");
      else fail("invite replay", `got "${replay}"`);

      await one.page.close();
      await one.ctx.close();
      await two.page.close();
      await two.ctx.close();

      /* ti-007 — re-inviting a DEACTIVATED teammate. */
      const fUser = await db.user.findFirst({ where: { companyId: A.companyId, email: fEmail } });
      if (fUser) {
        await gotoTeam(admin);
        await admin.evaluate((n) => {
          const btn = [...document.querySelectorAll("button")].find((b) =>
            new RegExp(`Deactivate ${n}`, "i").test(b.getAttribute("aria-label") ?? "")
          );
          btn?.click();
        }, `QA Eff ${STAMP}`);
        await confirmDialog(admin, "Deactivate");
        const toast = await submitInvite(admin, {
          name: `QA Eff ${STAMP}`,
          email: fEmail,
          role: "member",
        });
        if (/deactivat|reactivat/i.test(toast)) {
          ok(`re-inviting a deactivated teammate explains itself: "${toast.trim()}"`);
        } else {
          fail(
            "ti-007 misleading re-invite error",
            `expected a message pointing at Reactivate; got "${toast.trim()}"`
          );
        }
      }
    });

    /* ══ ti-004 — an EXPIRED invite still consumes a free-plan seat ═══════ */
    await block("expired invites hold a seat forever", async () => {
      const { ctx, page } = await newCtx(browser, "tenant-p", "p");
      const P = await signUpTenant(page, "teamp");
      const pEmail = `qa-teamp-x-${STAMP}@founderflow.test`;
      await submitInvite(page, { name: `QA Pee ${STAMP}`, email: pEmail, role: "member" });
      const row = await inviteRow(P.companyId, pEmail);
      if (!row) {
        await page.close();
        await ctx.close();
        return fail("expired-seat setup", "no invite row in tenant P");
      }
      // Age MY OWN invite rather than waiting seven days. Nothing in the
      // product ever clears an expired-but-unused token in a live workspace:
      // the purge cron only touches inviteToken inside a whole-company purge.
      await db.inviteToken.update({
        where: { id: row.id },
        data: { expiresAt: new Date(Date.now() - 86400000) },
      });
      await gotoTeam(page);
      const flagged = await page.evaluate(() => /expired/i.test(document.body.innerText));
      if (flagged) ok("an expired invite is flagged on /team");
      else fail("expired flag", "the roster does not mark it expired");

      const toast = await submitInvite(page, {
        name: `QA Pee2 ${STAMP}`,
        email: `qa-teamp-y-${STAMP}@founderflow.test`,
        role: "member",
      });
      const second = await inviteRow(P.companyId, `qa-teamp-y-${STAMP}@founderflow.test`);
      if (second) {
        ok("an expired invite does not hold a seat");
      } else {
        fail(
          "ti-004 expired invite holds a seat",
          `an UNUSABLE expired invite blocks the next one, and the message blames the plan: "${toast.trim()}"`
        );
        await page.screenshot({ path: `${OUT}/07-expired-seat-${STAMP}.png` });
      }
      await page.close();
      await ctx.close();
    });

    /* ══ ti-005 — two invites at once, one free seat ══════════════════════ */
    await block("free-plan cap under concurrency", async () => {
      const { ctx, page } = await newCtx(browser, "tenant-r", "r");
      const R = await signUpTenant(page, "teamr");
      // Second tab, SAME session: two in-flight inviteUserAction calls read
      // the member count before either writes its token.
      const tab = await ctx.newPage();
      wire(tab, "tenant-r-2");
      await tab.setExtraHTTPHeaders({ "x-real-ip": IP("r") });

      const e1 = `qa-teamr-1-${STAMP}@founderflow.test`;
      const e2 = `qa-teamr-2-${STAMP}@founderflow.test`;
      await Promise.allSettled([
        submitInvite(page, { name: `QA Arr1 ${STAMP}`, email: e1, role: "member" }),
        submitInvite(tab, { name: `QA Arr2 ${STAMP}`, email: e2, role: "member" }),
      ]);

      const [seatsUsed, pending] = await Promise.all([
        activeUsers(R.companyId),
        db.inviteToken.count({ where: { companyId: R.companyId, usedAt: null } }),
      ]);
      if (seatsUsed + pending <= FREE_MEMBER_LIMIT) {
        ok(`cap held under two concurrent invites (${seatsUsed} users + ${pending} pending)`);
      } else {
        fail(
          "ti-005 cap check is not atomic",
          `tenant ${R.companyId} holds ${seatsUsed} users + ${pending} pending = ` +
            `${seatsUsed + pending} against a limit of ${FREE_MEMBER_LIMIT}`
        );
      }
      await tab.close();
      await page.close();
      await ctx.close();
    });

    /* ══ ti-012 — an invite outlives the workspace it points at ═══════════ */
    await block("invite into a deleted workspace", async () => {
      const { ctx, page } = await newCtx(browser, "tenant-w", "w");
      const W = await signUpTenant(page, "teamw");
      const gEmail = `qa-teamw-g-${STAMP}@founderflow.test`;
      await submitInvite(page, { name: `QA Gee ${STAMP}`, email: gEmail, role: "member" });
      const gRow = await inviteRow(W.companyId, gEmail);
      await page.close();
      await ctx.close();
      if (!gRow) return fail("deleted-workspace setup", "no invite row in tenant W");

      // Simulate deleteWorkspaceAction on MY OWN tenant. This is exactly what
      // softDeleteWorkspace() in lib/actions/account.ts writes for the two
      // tables that matter here; the rest of the sweep is irrelevant to the
      // question and this keeps the blast radius to one company I created.
      const tombstone = new Date();
      await db.$transaction([
        db.user.updateMany({
          where: { companyId: W.companyId, deletedAt: null },
          data: { deletedAt: tombstone },
        }),
        db.company.update({ where: { id: W.companyId }, data: { deletedAt: tombstone } }),
      ]);

      const { ctx: gCtx, page: gPage } = await newCtx(browser, "invitee-g", "g");
      await gPage.goto(`${BASE}/invite/${gRow.token}`, { waitUntil: "networkidle0" });
      const heading = await headingOf(gPage);
      const formShown = !!(await gPage.$("input[type=password]"));
      await gPage.screenshot({ path: `${OUT}/08-invite-deleted-workspace-${STAMP}.png` });

      if (!formShown) {
        ok(`an invite into a deleted workspace is refused at the page: "${heading}"`);
      } else {
        const res = await acceptInvite(gPage, gRow.token, `QaInvite${STAMP}!g`);
        const ghost = await db.user.findFirst({
          where: { companyId: W.companyId, email: gEmail },
          select: { id: true, deletedAt: true },
        });
        const company = await db.company.findUnique({
          where: { id: W.companyId },
          select: { deletedAt: true },
        });
        if (ghost && ghost.deletedAt === null && company?.deletedAt) {
          fail(
            "ti-012 account created inside a deleted workspace",
            `the invite page offered the form ("${heading}"), acceptance landed on ${res.url}, ` +
              `and a LIVE user row now sits in tombstoned company ${W.companyId}. ` +
              "The purge cron hard-deletes that company, taking the account with it, " +
              "and the email address is permanently unavailable for a fresh signup."
          );
        } else {
          ok("acceptance into a deleted workspace was refused by the action");
        }
      }
      await gPage.close();
      await gCtx.close();
    });

    /* ══ cross-tenant isolation (the required negative result) ════════════ */
    await block("cross-tenant isolation of the roster", async () => {
      const { ctx, page } = await newCtx(browser, "tenant-x", "x");
      const X = await signUpTenant(page, "teamx");
      await gotoTeam(page);
      const body = await page.evaluate(() => document.body.innerText);
      const leaks = [A.email, bEmail, `qa-team-e-${STAMP}@founderflow.test`].filter((e) =>
        body.includes(e)
      );
      if (leaks.length === 0) ok("tenant X's /team shows nothing from tenant A");
      else fail("cross-tenant roster leak", leaks.join(", "));

      const mine = await db.user.count({ where: { companyId: X.companyId, deletedAt: null } });
      if (mine === 1) ok("tenant X holds exactly its founder");
      else fail("tenant X roster", `expected 1 active user, found ${mine}`);

      const foreignInvites = await db.inviteToken.count({
        where: { companyId: X.companyId, email: { in: [bEmail] } },
      });
      if (foreignInvites === 0) ok("tenant A's invites are not visible inside tenant X");
      else fail("cross-tenant invite leak", `${foreignInvites} rows`);
      await page.screenshot({ path: `${OUT}/09-tenant-x-team-${STAMP}.png` });
      await page.close();
      await ctx.close();
    });

    if (bPage) {
      await bPage.close().catch(() => {});
      await bCtx.close().catch(() => {});
    }
  } catch (e) {
    fail("run", e.message);
  } finally {
    /* ── Teardown: ONLY this agent's tenants, children before parents. ──── */
    for (const companyId of myTenants) {
      try {
        await db.messageReaction.deleteMany({ where: { message: { companyId } } });
        await db.message.deleteMany({ where: { companyId } });
        await db.channelMember.deleteMany({ where: { channel: { companyId } } });
        await db.channel.deleteMany({ where: { companyId } });
        await db.comment.deleteMany({ where: { companyId } });
        await db.timeEntry.deleteMany({ where: { companyId } });
        await db.notification.deleteMany({ where: { companyId } });
        await db.activity.deleteMany({ where: { companyId } });
        await db.inviteToken.deleteMany({ where: { companyId } });
        await db.recurringRule.deleteMany({ where: { companyId } });
        await db.budget.deleteMany({ where: { companyId } });
        await db.transaction.deleteMany({ where: { companyId } });
        await db.task.deleteMany({ where: { companyId } });
        await db.project.deleteMany({ where: { companyId } });
        await db.notificationPreference.deleteMany({ where: { user: { companyId } } });
        await db.pushSubscription.deleteMany({ where: { user: { companyId } } });
        await db.company.update({ where: { id: companyId }, data: { ownerId: null } });
        await db.user.deleteMany({ where: { companyId } });
        await db.company.delete({ where: { id: companyId } });
        console.log(`  ..  swept tenant ${companyId}`);
      } catch (e) {
        console.error(`  cleanup failed for ${companyId}:`, e.message);
      }
    }
    await browser.close().catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n  ${passes} assertion(s) passed`);
  console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
}

main().catch((err) => {
  console.error("❌ qa-team-and-invites threw:", err);
  process.exit(1);
});
