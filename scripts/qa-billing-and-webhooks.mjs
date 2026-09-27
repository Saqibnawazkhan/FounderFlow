/*
 * QA EXERCISE SCRIPT — domain: billing-and-webhooks  (AGENT_INDEX = 12)
 *
 * Authored in Phase 1 (static). Phase 2 RUNS it. Every block below exists to
 * promote one Phase-1 `static` finding to `observed`, or to hold one of the
 * negativeResults honest. The finding id each block proves is in its header,
 * e.g. [BILL-004].
 *
 * Surface under test:
 *   app/api/webhooks/lemonsqueezy/route.ts  (HMAC, replay, ordering, workspace
 *     resolution, status -> plan mapping, error handling)
 *   lib/actions/billing.ts                  (checkout + portal server actions)
 *   lib/billing/plan.ts                     (plan model + the member cap)
 *   lib/lemonsqueezy/config.ts              (the configured/unconfigured gates)
 *   lib/queries/billing.ts + the "Plan & billing" Section of /settings
 *   Company.plan / billingCustomerId / billingSubscriptionId /
 *   subscriptionStatus / currentPeriodEnd
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DATA SAFETY — the hardest rule in this audit.
 *
 * This is the money path, so the temptation to "just flip demo-nimbus to team
 * for a second" is exactly the accident the guard exists to catch. This script
 * never writes a row it did not create:
 *
 *  - Every tenant is created through the real /signup flow, named
 *    `qa-bill-<slug>-<stamp>` so scripts/_qa-guard.mjs's sweeper finds it.
 *  - `mine(companyId)` THROWS unless the id is in `myTenants`. Every webhook
 *    payload's `custom_data.company_id`, and every DB read/write, goes through
 *    it. A typo cannot reach somebody else's workspace, and the literal string
 *    "demo-nimbus" is rejected explicitly with its own message.
 *  - Every DB assertion carries `where: { id: <my company> }` or
 *    `where: { companyId: <my company> }`. There is not one bare
 *    `db.X.count()`: under concurrency another agent's insert could satisfy a
 *    global "did mine land?" check and produce a FALSE PASS, the most
 *    expensive outcome in a pre-launch audit.
 *  - The CROSS-TENANT forgery test (block 5) forges one of MY OWN tenants'
 *    ids from another of MY OWN tenants' subscription. That proves the
 *    capability without touching a single row that predates this run.
 *  - Seeded data is read nowhere and asserted on nowhere.
 *    `node scripts/_qa-guard.mjs verify` must pass after this script,
 *    including its row-content hashes.
 *
 * Direct DB writes this script makes, all to rows IT created, each justified
 * at its call site:
 *   W1. `company.deletedAt` on my own tenant H — the only way to observe that
 *       the webhook will still upgrade a TOMBSTONED workspace, because no
 *       webhook payload can set that column.
 *   W2. Nothing else. Every other mutation on my tenants goes through the real
 *       HTTP surface (signup, invite, accept, and signed webhook POSTs).
 *       No UPDATE and no DELETE outside the `myTenants` teardown.
 *
 * NOTE ON WHAT IS *NOT* OBSERVABLE LOCALLY: `.env.local` sets
 * LEMONSQUEEZY_WEBHOOK_SECRET but NOT LEMONSQUEEZY_API_KEY / STORE_ID /
 * VARIANT_ID_TEAM, so `isBillingConfigured()` is false and the Plan section
 * renders "Billing isn't set up on this deployment." with no Upgrade / Manage
 * button. Checkout + portal round-trips therefore cannot be driven here (they
 * would also take real money). Block 16 asserts the unconfigured state
 * faithfully; the checkout-side findings stay `static` and capped at P2.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Conventions copied from scripts/smoke-chat.mjs and
 * scripts/qa-team-and-invites.mjs / qa-account-and-workspace-settings.mjs:
 *   - localDb() only. A bare `new PrismaClient()` auto-loads the ROOT .env,
 *     which points at PRODUCTION Supabase.
 *   - ok()/fail() with process.exitCode. fail() NEVER throws, so one run
 *     reports every broken assertion; a literal U+274C is printed so the
 *     runner's summary counts it.
 *   - The retry-until-hydrated signIn helper, verbatim (FaultsAudit A14).
 *   - x-real-ip on every page/context BEFORE its first navigation, and on
 *     every webhook fetch. getClientIp() falls back to the literal "unknown"
 *     in dev, so without it all agents share ONE limiters.auth bucket
 *     (5 / 60s) fed by nine call sites.
 *   - waitForFunction on state predicates, never a fixed setTimeout for
 *     correctness (the two short sleeps that remain are hydration windows
 *     copied verbatim from the reference helpers).
 *   - Per-agent screenshot directory.
 *   - db.$disconnect() in finally; tenant teardown children-before-parents.
 */

import crypto from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const OUT = "C:/Users/USER/AppData/Local/Temp/ff-qa/billing-and-webhooks";
mkdirSync(OUT, { recursive: true });

const STAMP = Date.now().toString().slice(-8);
const HOOK = `${BASE}/api/webhooks/lemonsqueezy`;

/**
 * AGENT_INDEX 12 -> x-real-ip 10.99.0.12, with a distinct SUFFIX per browser
 * context inside this agent's own lane. This script performs ~8 signups plus a
 * dozen logins and `limiters.auth` is 5 per 60s keyed on the raw header
 * string, so one lane could not survive its own test plan. `10.99.0.12-e`
 * still reads unmistakably as agent 12's.
 */
const IP = (suffix) => (suffix ? `10.99.0.12-${suffix}` : "10.99.0.12");

const db = localDb();

/** Tenant ids this run created. Everything here is torn down in `finally`. */
const myTenants = [];

let passes = 0;
function ok(label) {
  passes += 1;
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  // U+274C so the runner's summary counts this line. Never throws: one run
  // must report every broken assertion, not stop at the first.
  console.error(`  \u274c  FAIL  ${label}${detail ? ` \u2014 ${detail}` : ""}`);
  process.exitCode = 1;
}
function note(label) {
  console.log(`  ..  ${label}`);
}

/**
 * THE DATA-SAFETY CHOKE POINT.
 *
 * Returns the id only if this run created it. Every webhook payload built
 * below routes its `company_id` through this, and so does every DB scope. A
 * mistyped or copy-pasted foreign id throws instead of being written.
 */
function mine(companyId) {
  if (companyId === "demo-nimbus") {
    throw new Error(
      "DATA-SAFETY: refusing to touch the seeded demo workspace (demo-nimbus). " +
        "This script may only act on tenants it signed up itself."
    );
  }
  if (!myTenants.includes(companyId)) {
    throw new Error(
      `DATA-SAFETY: "${companyId}" is not one of this run's tenants ` +
        `(${myTenants.join(", ") || "none yet"}). Refusing.`
    );
  }
  return companyId;
}

/** Pull one key out of .env.local. Never process.env, never the root .env. */
function envLocal(key) {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    if (t.slice(0, eq).trim() !== key) continue;
    return t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return null;
}

const LS_SECRET = envLocal("LEMONSQUEEZY_WEBHOOK_SECRET");

/* ─────────────────────── webhook plumbing ──────────────────────────────── */

/** The signature LemonSqueezy would send: hex HMAC-SHA256 over the RAW body. */
function sign(raw) {
  return crypto.createHmac("sha256", LS_SECRET).update(raw).digest("hex");
}

/**
 * POST one webhook delivery.
 *
 * `body` may be an object (stringified here, and the signature is computed
 * over EXACTLY the bytes sent) or a pre-serialised string, which is how the
 * replay tests re-send byte-identical deliveries.
 *
 * `signature: null` omits the header entirely.
 */
async function deliver(body, { signature, contentType = "application/json" } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(HOOK, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-real-ip": IP("hook"),
      ...(signature === null ? {} : { "x-signature": signature ?? sign(raw) }),
    },
    body: raw,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* a non-JSON body is itself information; `json` stays null */
  }
  return { status: res.status, json, raw };
}

const isoIn = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

/**
 * A LemonSqueezy subscription webhook payload, shaped like the real thing.
 *
 * `companyId` is routed through `mine()` — a payload can only ever be aimed at
 * a tenant this run created.
 */
function subEvent(
  eventName,
  {
    companyId,
    status,
    subId,
    customerId,
    endsAt = null,
    renewsAt = null,
    testMode = false,
    omitCustomData = false,
    storeId = 987654,
    variantId = 111222,
    attrOverrides = {},
    dropAttrs = [],
  }
) {
  const attributes = {
    store_id: storeId,
    customer_id: customerId,
    order_id: 5550001,
    order_item_id: 5550002,
    product_id: 333444,
    variant_id: variantId,
    product_name: "FounderFlow Team",
    variant_name: "Monthly",
    user_name: "QA Buyer",
    user_email: `qa-buyer-${STAMP}@founderflow.test`,
    status,
    status_formatted: status,
    card_brand: "visa",
    card_last_four: "4242",
    pause: null,
    cancelled: status === "cancelled",
    trial_ends_at: null,
    billing_anchor: 1,
    urls: {
      update_payment_method: "https://example.test/pm",
      customer_portal: "https://example.test/portal",
    },
    renews_at: renewsAt,
    ends_at: endsAt,
    created_at: isoIn(-30),
    updated_at: new Date().toISOString(),
    test_mode: testMode,
    ...attrOverrides,
  };
  for (const k of dropAttrs) delete attributes[k];

  return {
    meta: {
      event_name: eventName,
      ...(omitCustomData ? {} : { custom_data: { company_id: mine(companyId) } }),
    },
    data: { type: "subscriptions", id: String(subId), attributes },
  };
}

/** The billing columns of ONE of my companies. Always scoped by id. */
async function billingRow(companyId) {
  return db.company.findUnique({
    where: { id: mine(companyId) },
    select: {
      id: true,
      plan: true,
      subscriptionStatus: true,
      billingCustomerId: true,
      billingSubscriptionId: true,
      currentPeriodEnd: true,
      deletedAt: true,
    },
  });
}

/* ───────────────────────── browser plumbing ────────────────────────────── */

function wire(page, tag) {
  page.on("pageerror", (e) => console.error(`PAGEERROR[${tag}]:`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`CONSOLE.error[${tag}]:`, m.text());
  });
}

/** A fresh browser context: own cookie jar, own rate-limit key. */
async function newCtx(browser, tag, ipSuffix) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 1100 });
  wire(page, tag);
  // BEFORE the first navigation, per the audit brief.
  await page.setExtraHTTPHeaders({ "x-real-ip": IP(ipSuffix) });
  return { ctx, page };
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}-${STAMP}.png`, fullPage: true }).catch(() => {});
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
      return true;
    }
  }
  return false;
}

/**
 * Create one of THIS AGENT'S tenants through the real /signup flow.
 *
 * companyId is resolved by the OWNER'S EMAIL, never by "the newest company":
 * another agent signing up in the same second would otherwise hand us their
 * tenant id and every later assertion would be scoped to somebody else's data.
 */
async function signUpTenant(page, slug) {
  const companyName = `qa-bill-${slug}-${STAMP}`;
  const email = `qa-bill-${slug}-${STAMP}@founderflow.test`;
  const password = `QaBill${STAMP}!a`;
  const name = `QA Bill ${slug} ${STAMP}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0" });
    await page.waitForSelector('input[name="name"]', { timeout: 30000 });
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
    await page.click('form button[type="submit"]');

    const landed = await page
      .waitForFunction(() => location.pathname.startsWith("/dashboard"), { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (landed) break;
    if (attempt === 3) throw new Error(`signup failed for ${companyName}: ${page.url()}`);
  }

  const owner = await db.user.findUnique({
    where: { email },
    select: { id: true, companyId: true },
  });
  if (!owner) throw new Error(`signup produced no user row for ${email}`);
  myTenants.push(owner.companyId);
  return { companyId: owner.companyId, userId: owner.id, email, password, companyName, name };
}

/** Land on /settings and wait for the page's own content, not a clock. */
async function gotoSettings(page) {
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle0", timeout: 60000 });
  await page
    .waitForFunction(() => /Danger zone|Plan & billing|Appearance/i.test(document.body.innerText), {
      timeout: 30000,
    })
    .catch(() => {});
}

/**
 * The rendered text + buttons of the "Plan & billing" Section, or null when
 * the section is not on the page at all (which is the correct answer for a
 * cofounder or a member — settings-client.tsx gates it on role === "admin").
 */
async function planSection(page) {
  return page.evaluate(() => {
    const label = [...document.querySelectorAll("*")].find(
      (el) => el.children.length === 0 && /^\s*Plan\s*&\s*billing\s*$/i.test(el.textContent ?? "")
    );
    if (!label) return null;
    let node = label;
    for (let i = 0; i < 6 && node.parentElement; i++) {
      node = node.parentElement;
      if (/Solo|Team/.test(node.innerText ?? "")) break;
    }
    return {
      text: node.innerText,
      html: node.innerHTML,
      buttons: [...node.querySelectorAll("button")].map((b) => b.textContent.trim()),
    };
  });
}

async function gotoTeam(page) {
  await page.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
  await page
    .waitForFunction(() => /Invite member|Team|No teammates/i.test(document.body.innerText), {
      timeout: 30000,
    })
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
  await page.keyboard.press("Escape").catch(() => {});
  return toast;
}

/** Set the password on /invite/[token] and submit. */
async function acceptInvite(page, token, password) {
  await page.goto(`${BASE}/invite/${token}`, { waitUntil: "networkidle0", timeout: 60000 });
  const hasForm = await page.$("input[type=password]");
  if (!hasForm) return { accepted: false, url: page.url() };
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
  return { accepted: landed, url: page.url() };
}

/** The most recent pending invite for an email IN ONE OF MY TENANTS. */
function inviteRow(companyId, email) {
  return db.inviteToken.findFirst({
    where: { companyId: mine(companyId), email },
    orderBy: { createdAt: "desc" },
  });
}

/** One block, isolated: a throw inside it fails that block, not the run. */
async function block(label, fn) {
  console.log(`\n-- ${label} --`);
  try {
    await fn();
  } catch (err) {
    fail(label, err?.message ?? String(err));
  }
}

/* ══════════════════════════════ main ════════════════════════════════════ */

async function main() {
  if (!LS_SECRET) {
    console.error(
      "\u274c  FAIL  no LEMONSQUEEZY_WEBHOOK_SECRET in .env.local — every webhook " +
        "block below would only observe the 503 'Billing not configured' path."
    );
    process.exitCode = 1;
    return;
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });

  console.log("== billing-and-webhooks QA (agent 12) ==");
  console.log(`   webhook: ${HOOK}`);

  // Subscription / customer ids this run invents. Distinct per tenant so a
  // leak between blocks is visible rather than coincidentally correct.
  const SUB = (n) => 900000 + Number(STAMP.slice(-3)) * 10 + n;
  const CUST = (n) => 700000 + Number(STAMP.slice(-3)) * 10 + n;

  try {
    /* ══ tenant A — the happy path workspace ═══════════════════════════════ */
    const aCtx = await newCtx(browser, "tenant-a", "a");
    const A = await signUpTenant(aCtx.page, "a");
    note(`tenant A = ${A.companyId}`);

    /* ══ BLOCK 1 — HMAC verification [negative result NR1] ═════════════════
     * The signature check is the only thing standing between the internet and
     * `plan = "team"`. Six ways to get it wrong, each asserted to be rejected
     * AND to have left tenant A's billing columns untouched.
     */
    await block("block 1: HMAC signature verification", async () => {
      const payload = subEvent("subscription_created", {
        companyId: A.companyId,
        status: "active",
        subId: SUB(1),
        customerId: CUST(1),
        renewsAt: isoIn(30),
      });
      const raw = JSON.stringify(payload);
      const good = sign(raw);

      const cases = [
        ["no x-signature header at all", { signature: null }],
        ["empty x-signature", { signature: "" }],
        ["non-hex garbage", { signature: "z".repeat(64) }],
        ["63 hex chars (short by one nibble)", { signature: good.slice(0, 63) }],
        ["65 hex chars (long by one nibble)", { signature: good + "a" }],
        ["a valid-shape but wrong digest", { signature: "a".repeat(64) }],
        ["the digest with one byte flipped", { signature: flipHexByte(good) }],
        ["a base64 digest instead of hex", {
          signature: crypto.createHmac("sha256", LS_SECRET).update(raw).digest("base64"),
        }],
        ["a correct signature over a DIFFERENT body", { signature: sign(raw + " ") }],
      ];

      for (const [label, opts] of cases) {
        const res = await deliver(raw, opts);
        if (res.status === 400) ok(`rejected 400: ${label}`);
        else fail(`signature check accepted ${label}`, `status ${res.status}`);
        if (res.json && JSON.stringify(res.json).includes(good)) {
          fail("400 response leaks the expected digest", JSON.stringify(res.json));
        }
      }

      const after = await billingRow(A.companyId);
      if (after.plan === "free" && !after.billingSubscriptionId && !after.subscriptionStatus) {
        ok("after 9 bad signatures tenant A is still free with no billing ids");
      } else {
        fail("a rejected webhook still wrote to my company row", JSON.stringify(after));
      }

      // And a GET is not a webhook.
      const getRes = await fetch(HOOK, { method: "GET", headers: { "x-real-ip": IP("hook") } });
      if (getRes.status === 405) ok("GET /api/webhooks/lemonsqueezy -> 405");
      else note(`GET on the webhook returned ${getRes.status} (expected 405)`);
    });

    /* ══ BLOCK 2 — happy path: a signed subscription_created upgrades ══════
     * [BILL-happy] Establishes the baseline every later block deviates from.
     */
    let aCreatedRaw = null;
    let aCreatedSig = null;
    await block("block 2: happy path — signed subscription_created upgrades", async () => {
      const renews = isoIn(30);
      const payload = subEvent("subscription_created", {
        companyId: A.companyId,
        status: "active",
        subId: SUB(1),
        customerId: CUST(1),
        renewsAt: renews,
      });
      aCreatedRaw = JSON.stringify(payload);
      aCreatedSig = sign(aCreatedRaw);

      const res = await deliver(aCreatedRaw, { signature: aCreatedSig });
      if (res.status === 200 && res.json?.received === true) ok("200 { received: true }");
      else fail("happy-path webhook", `status ${res.status} body ${JSON.stringify(res.json)}`);

      const row = await billingRow(A.companyId);
      const checks = [
        ["plan", row.plan, "team"],
        ["subscriptionStatus", row.subscriptionStatus, "active"],
        ["billingSubscriptionId", row.billingSubscriptionId, String(SUB(1))],
        ["billingCustomerId", row.billingCustomerId, String(CUST(1))],
        [
          "currentPeriodEnd",
          row.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
          new Date(renews).toISOString(),
        ],
      ];
      for (const [field, actual, expected] of checks) {
        if (String(actual) === String(expected)) ok(`Company.${field} = ${actual}`);
        else fail(`Company.${field}`, `expected ${expected}, got ${actual}`);
      }

      // The UI agrees with the database.
      await signIn(aCtx.page, A.email, A.password);
      await gotoSettings(aCtx.page);
      const sec = await planSection(aCtx.page);
      await shot(aCtx.page, "02-plan-active");
      if (!sec) return fail("Plan & billing section", "not rendered for the admin");
      if (/\bTeam\b/.test(sec.text) && /ACTIVE|active/i.test(sec.text)) {
        ok("/settings shows Team + the ACTIVE status badge");
      } else {
        fail("/settings plan display", JSON.stringify(sec.text));
      }
    });

    /* ══ BLOCK 3 — replay + idempotency [BILL-002] ═════════════════════════
     * There is no event-id ledger and no timestamp window, so the SAME signed
     * bytes can be delivered any number of times, at any later date. The
     * damaging shape is not the duplicate — it is the STALE one: replaying the
     * original `active` delivery after the subscription has expired puts the
     * workspace back on the paid plan for free, permanently.
     */
    await block("block 3: replay of a stale signed delivery re-grants Team", async () => {
      for (let i = 2; i <= 3; i++) {
        const dup = await deliver(aCreatedRaw, { signature: aCreatedSig });
        if (dup.status === 200) ok(`duplicate delivery #${i} accepted (200) — no dedup ledger`);
        else fail(`duplicate delivery #${i}`, `status ${dup.status}`);
      }

      // The subscription genuinely ends.
      const expired = subEvent("subscription_expired", {
        companyId: A.companyId,
        status: "expired",
        subId: SUB(1),
        customerId: CUST(1),
        endsAt: isoIn(-1),
      });
      await deliver(expired);
      const downgraded = await billingRow(A.companyId);
      if (downgraded.plan === "free") ok("subscription_expired downgrades to free");
      else fail("subscription_expired", `plan is ${downgraded.plan}`);

      // Now replay the ORIGINAL, byte-identical, still-validly-signed delivery.
      const replay = await deliver(aCreatedRaw, { signature: aCreatedSig });
      const after = await billingRow(A.companyId);
      if (after.plan === "team") {
        fail(
          "[BILL-002] replaying a stale signed delivery re-granted the paid plan",
          `status ${replay.status}; plan back to "team", status "${after.subscriptionStatus}", ` +
            `currentPeriodEnd ${after.currentPeriodEnd?.toISOString()}`
        );
      } else {
        ok("a stale replay did NOT resurrect the paid plan");
      }
    });

    /* ══ BLOCK 4 — out-of-order delivery [BILL-003] ════════════════════════
     * LemonSqueezy retries a failed delivery with backoff, so a retry can land
     * AFTER a newer event. Nothing here compares `attributes.updated_at` to
     * what is stored, so the last writer wins — and a retried `expired` beats
     * a live `active`. The customer is paying and is on the free plan.
     */
    const bCtx = await newCtx(browser, "tenant-b", "b");
    const B = await signUpTenant(bCtx.page, "b");
    await block("block 4: a retried older event clobbers a newer one", async () => {
      // The old subscription ends...
      const oldExpired = subEvent("subscription_expired", {
        companyId: B.companyId,
        status: "expired",
        subId: SUB(10),
        customerId: CUST(10),
        endsAt: isoIn(-2),
        attrOverrides: { updated_at: isoIn(-2) },
      });
      const oldRaw = JSON.stringify(oldExpired);
      const oldSig = sign(oldRaw);
      await deliver(oldRaw, { signature: oldSig });

      // ...the customer resubscribes, and the NEW event is applied.
      await deliver(
        subEvent("subscription_created", {
          companyId: B.companyId,
          status: "active",
          subId: SUB(11),
          customerId: CUST(10),
          renewsAt: isoIn(29),
          attrOverrides: { updated_at: new Date().toISOString() },
        })
      );
      const mid = await billingRow(B.companyId);
      if (mid.plan === "team" && mid.billingSubscriptionId === String(SUB(11))) {
        ok("the resubscription put tenant B on Team with the new subscription id");
      } else {
        fail("resubscription", JSON.stringify(mid));
      }

      // ...and LemonSqueezy now retries the older expired delivery.
      await deliver(oldRaw, { signature: oldSig });
      const after = await billingRow(B.companyId);
      if (after.plan === "free" || after.billingSubscriptionId === String(SUB(10))) {
        fail(
          "[BILL-003] a retried OLDER event overwrote the live subscription",
          `plan=${after.plan} status=${after.subscriptionStatus} ` +
            `billingSubscriptionId=${after.billingSubscriptionId} (live sub is ${SUB(11)}) ` +
            `periodEnd=${after.currentPeriodEnd?.toISOString()}`
        );
      } else {
        ok("the out-of-order retry was ignored");
      }
    });

    /* ══ BLOCK 5 — forged company_id / cross-tenant billing seizure ════════
     * [BILL-001] `resolveCompanyId` trusts `meta.custom_data.company_id`
     * without checking that the target workspace has anything to do with this
     * subscription, and `updateMany` is scoped only by that id. The custom
     * field is set from a checkout URL, and a LemonSqueezy hosted buy link
     * accepts `?checkout[custom][company_id]=...` from whoever opens it.
     *
     * BOTH tenants here are MINE. C plays the victim, D plays the attacker's
     * own workspace. No pre-existing row is involved in any way.
     */
    const cCtx = await newCtx(browser, "tenant-c", "c");
    const C = await signUpTenant(cCtx.page, "c");
    const dCtx = await newCtx(browser, "tenant-d", "d");
    const D = await signUpTenant(dCtx.page, "d");
    await block("block 5: a forged company_id seizes another workspace's billing", async () => {
      // C pays for itself, honestly.
      await deliver(
        subEvent("subscription_created", {
          companyId: C.companyId,
          status: "active",
          subId: SUB(20),
          customerId: CUST(20),
          renewsAt: isoIn(30),
        })
      );
      const before = await billingRow(C.companyId);
      if (before.billingCustomerId === String(CUST(20))) ok("victim C owns its own billing link");
      else return fail("setup for the forgery test", JSON.stringify(before));

      // The attacker buys their OWN subscription (customer CUST(21), sub
      // SUB(21)) but points custom_data at C.
      await deliver(
        subEvent("subscription_created", {
          companyId: C.companyId, // forged
          status: "active",
          subId: SUB(21),
          customerId: CUST(21),
          renewsAt: isoIn(30),
        })
      );
      const after = await billingRow(C.companyId);
      if (
        after.billingCustomerId === String(CUST(21)) &&
        after.billingSubscriptionId === String(SUB(21))
      ) {
        fail(
          "[BILL-001] a subscription belonging to someone else took over C's billing record",
          `C.billingCustomerId ${CUST(20)} -> ${after.billingCustomerId}, ` +
            `billingSubscriptionId ${SUB(20)} -> ${after.billingSubscriptionId}. ` +
            "C's admin's 'Manage billing' now resolves the ATTACKER's subscription, and " +
            "C's own subscription is no longer reachable from the app."
        );
      } else {
        ok("the webhook refused to repoint C's billing record at a foreign subscription");
      }

      // ...and cancelling the attacker's subscription downgrades the victim.
      await deliver(
        subEvent("subscription_expired", {
          companyId: C.companyId, // forged
          status: "expired",
          subId: SUB(21),
          customerId: CUST(21),
          endsAt: isoIn(-1),
        })
      );
      const killed = await billingRow(C.companyId);
      if (killed.plan === "free") {
        fail(
          "[BILL-001] a third party downgraded a paying workspace to free",
          `C.plan = "${killed.plan}" while C's own subscription ${SUB(20)} was never cancelled`
        );
      } else {
        ok("a foreign expiry could not downgrade C");
      }

      // D is untouched — the forgery is a write to ONE row, not a broadcast.
      const dRow = await billingRow(D.companyId);
      if (dRow.plan === "free" && !dRow.billingSubscriptionId) {
        ok("tenant D (uninvolved) was not modified");
      } else {
        fail("collateral write to an uninvolved tenant", JSON.stringify(dRow));
      }
    });

    /* ══ BLOCK 6 — `cancelled` is treated as paid with no expiry check ═════
     * [BILL-004] PAID_STATUSES contains "cancelled" so access survives the
     * notice period — but NOTHING anywhere compares currentPeriodEnd to now.
     * If `subscription_expired` is lost (or poisoned, see block 10), the
     * workspace keeps paid capacity forever. Observed two ways: the column,
     * and the member cap that is the only thing `plan` actually gates.
     */
    const eCtx = await newCtx(browser, "tenant-e", "e");
    const E = await signUpTenant(eCtx.page, "e");
    await block("block 6: a cancelled subscription whose period already ended keeps Team", async () => {
      await deliver(
        subEvent("subscription_created", {
          companyId: E.companyId,
          status: "active",
          subId: SUB(30),
          customerId: CUST(30),
          renewsAt: isoIn(30),
        })
      );
      await deliver(
        subEvent("subscription_cancelled", {
          companyId: E.companyId,
          status: "cancelled",
          subId: SUB(30),
          customerId: CUST(30),
          endsAt: isoIn(-45), // the notice period ended six weeks ago
        })
      );
      const row = await billingRow(E.companyId);
      if (row.plan === "team" && row.currentPeriodEnd && row.currentPeriodEnd < new Date()) {
        fail(
          "[BILL-004] plan is still \"team\" with currentPeriodEnd in the past",
          `currentPeriodEnd=${row.currentPeriodEnd.toISOString()} status=${row.subscriptionStatus}`
        );
      } else {
        ok(`a lapsed cancelled subscription resolved to plan=${row.plan}`);
      }

      // The paid capacity is really live: on free, the 2nd pending invite is
      // refused (1 active user + 1 pending >= 2). Scoped to MY tenant E.
      await signIn(eCtx.page, E.email, E.password);
      const i1 = `qa-bill-e1-${STAMP}@founderflow.test`;
      const i2 = `qa-bill-e2-${STAMP}@founderflow.test`;
      await submitInvite(eCtx.page, { name: `QA E1 ${STAMP}`, email: i1, role: "member" });
      const t2 = await submitInvite(eCtx.page, { name: `QA E2 ${STAMP}`, email: i2, role: "member" });
      const pending = await db.inviteToken.count({
        where: { companyId: mine(E.companyId), usedAt: null },
      });
      if (pending === 2) {
        fail(
          "[BILL-004] a lapsed cancelled workspace still spends unlimited seats",
          `2 pending invites exist in ${E.companyId}; the free cap is 2 total members`
        );
      } else {
        ok(`the seat cap applied (${pending} pending invite(s)); toast="${t2}"`);
      }

      // And the label the admin reads.
      await gotoSettings(eCtx.page);
      const sec = await planSection(eCtx.page);
      await shot(eCtx.page, "06-cancelled-renews");
      if (sec && /Renews/i.test(sec.text)) {
        fail(
          "[BILL-005] a cancelled subscription is labelled \"Renews <date>\"",
          `section reads: ${JSON.stringify(sec.text)} — the date is ends_at, i.e. when access STOPS`
        );
      } else {
        ok(`the cancelled state is not labelled as renewing: ${JSON.stringify(sec?.text)}`);
      }
    });

    /* ══ BLOCK 7 — test_mode / foreign variant grants a real paid plan ═════
     * [BILL-006] Nothing checks attributes.test_mode, store_id, product_id or
     * variant_id. A test-mode checkout takes no money; a different (cheaper)
     * variant in the same store takes the wrong amount. Both write plan=team.
     */
    const fCtx = await newCtx(browser, "tenant-f", "f");
    const F = await signUpTenant(fCtx.page, "f");
    await block("block 7: test_mode + wrong variant still grant Team", async () => {
      await deliver(
        subEvent("subscription_created", {
          companyId: F.companyId,
          status: "active",
          subId: SUB(40),
          customerId: CUST(40),
          renewsAt: isoIn(30),
          testMode: true,
          storeId: 1, // not this deployment's store
          variantId: 424242, // not LEMONSQUEEZY_VARIANT_ID_TEAM
        })
      );
      const row = await billingRow(F.companyId);
      if (row.plan === "team") {
        fail(
          "[BILL-006] a test_mode subscription for a foreign store/variant granted Team",
          `plan=${row.plan} status=${row.subscriptionStatus} (test_mode: true, store_id: 1, variant_id: 424242)`
        );
      } else {
        ok("test_mode / foreign store / foreign variant were rejected");
      }
    });

    /* ══ BLOCK 8 — a partial payload nulls the billing link [BILL-007] ═════
     * Every column is written unconditionally: an event whose attributes omit
     * customer_id writes NULL over it, destroying the ONLY fallback the
     * webhook has for resolving a workspace when custom_data is absent. Same
     * for the renewal date.
     */
    const gCtx = await newCtx(browser, "tenant-g", "g");
    const G = await signUpTenant(gCtx.page, "g");
    await block("block 8: an attribute-light event nulls customer id + period end", async () => {
      await deliver(
        subEvent("subscription_created", {
          companyId: G.companyId,
          status: "active",
          subId: SUB(50),
          customerId: CUST(50),
          renewsAt: isoIn(30),
        })
      );
      const before = await billingRow(G.companyId);
      if (before.billingCustomerId && before.currentPeriodEnd) ok("G starts with a full billing link");
      else return fail("setup for the partial-payload test", JSON.stringify(before));

      await deliver(
        subEvent("subscription_updated", {
          companyId: G.companyId,
          status: "active",
          subId: SUB(50),
          customerId: CUST(50),
          dropAttrs: ["customer_id", "renews_at", "ends_at"],
        })
      );
      const after = await billingRow(G.companyId);
      if (after.billingCustomerId === null || after.currentPeriodEnd === null) {
        fail(
          "[BILL-007] a partial event erased billing state instead of leaving it alone",
          `billingCustomerId ${before.billingCustomerId} -> ${after.billingCustomerId}, ` +
            `currentPeriodEnd ${before.currentPeriodEnd?.toISOString()} -> ${after.currentPeriodEnd}`
        );
      } else {
        ok("a partial event left the existing billing columns intact");
      }
    });

    /* ══ BLOCK 9 — an unresolvable workspace is silently dropped [BILL-008]
     * A paid event that names a company that does not exist, or a customer the
     * database has never seen, returns 200 { received: true }. LemonSqueezy
     * marks it delivered and never retries; nothing is written, logged or
     * alerted. The customer paid and nothing happened, with no trace to debug.
     */
    await block("block 9: an event for an unknown workspace is answered 200 and dropped", async () => {
      // A company id that cannot exist. NOT routed through mine() because it
      // is deliberately not mine — and it matches nothing, so it can write
      // nothing (asserted below by re-reading every tenant of this run).
      const bogus = `qa-bill-nonexistent-${STAMP}`;
      const payload = {
        meta: { event_name: "subscription_created", custom_data: { company_id: bogus } },
        data: {
          type: "subscriptions",
          id: String(SUB(60)),
          attributes: {
            customer_id: CUST(60),
            status: "active",
            renews_at: isoIn(30),
            ends_at: null,
            test_mode: false,
          },
        },
      };
      const res = await deliver(payload);
      if (res.status === 200 && res.json?.received === true) {
        fail(
          "[BILL-008] a paid event for an unresolvable workspace was acknowledged 200",
          `company_id "${bogus}" matches nothing; body ${JSON.stringify(res.json)}. ` +
            "LemonSqueezy will not retry and no record of the drop exists."
        );
      } else {
        ok(`an unresolvable event answered ${res.status} (retryable / recorded)`);
      }

      // Same shape with NO custom_data and an unseen customer id.
      const res2 = await deliver(
        subEvent("subscription_updated", {
          companyId: A.companyId, // only to satisfy the builder...
          status: "active",
          subId: SUB(61),
          customerId: 99_999_999, // ...but resolution falls back to THIS, which matches nothing
          renewsAt: isoIn(30),
          omitCustomData: true,
        })
      );
      if (res2.status === 200) {
        fail(
          "[BILL-008] an event with no custom_data and an unknown customer was acknowledged 200",
          `status ${res2.status} body ${JSON.stringify(res2.json)}`
        );
      } else {
        ok(`an unknown-customer event answered ${res2.status}`);
      }

      // Nothing leaked into any tenant of this run.
      for (const id of myTenants) {
        const r = await billingRow(id);
        if (r.billingSubscriptionId === String(SUB(60)) || r.billingSubscriptionId === String(SUB(61))) {
          fail("an unresolvable event wrote into one of my tenants", `${id}: ${JSON.stringify(r)}`);
        }
      }

      // Is there anywhere at all that a delivery is recorded? (Schema read
      // only — information_schema, no customer data.)
      const ledger = await db.$queryRawUnsafe(
        "select table_name from information_schema.tables where table_schema = 'public' and (table_name ilike '%webhook%' or table_name ilike '%billingevent%' or table_name ilike '%payment%')"
      );
      if (!ledger.length) {
        fail(
          "[BILL-009] there is no webhook-event ledger at all",
          "no table matching webhook/billingevent/payment exists, so a disputed charge " +
            "cannot be reconciled and a duplicate delivery cannot be detected"
        );
      } else {
        ok(`a delivery ledger exists: ${ledger.map((r) => r.table_name).join(", ")}`);
      }
    });

    /* ══ BLOCK 10 — one malformed field poisons the endpoint [BILL-010] ════
     * `new Date(attrs.renews_at)` on a value Prisma cannot store throws inside
     * the try, so the route answers 500 — which is exactly what makes
     * LemonSqueezy retry. The same bad payload will now be retried on a
     * schedule until LemonSqueezy gives up on the endpoint, and every event
     * behind it in the queue waits.
     */
    await block("block 10: an unparseable date turns the endpoint into a retry loop", async () => {
      const before = await billingRow(A.companyId);
      const res = await deliver(
        subEvent("subscription_updated", {
          companyId: A.companyId,
          status: "active",
          subId: SUB(1),
          customerId: CUST(1),
          attrOverrides: { renews_at: "soon", ends_at: null },
        })
      );
      const after = await billingRow(A.companyId);
      if (res.status === 500) {
        fail(
          "[BILL-010] a malformed date field makes the webhook answer 500 forever",
          `renews_at: "soon" -> status ${res.status}; the event never applies and ` +
            "LemonSqueezy retries the identical payload indefinitely"
        );
      } else if (res.status === 200 && after.currentPeriodEnd === null) {
        fail(
          "[BILL-010] a malformed date was silently coerced to no renewal date",
          `currentPeriodEnd ${before.currentPeriodEnd?.toISOString()} -> null`
        );
      } else {
        ok(`a malformed date answered ${res.status} and left the row consistent`);
      }
    });

    /* ══ BLOCK 11 — a tombstoned workspace is still upgradeable [BILL-011] ═
     * W1: the ONLY direct DB write in this script, to MY OWN tenant H. No
     * webhook payload can set deletedAt, and the point of the block is that
     * neither resolveCompanyId's fallback nor the updateMany filters it — so a
     * workspace the customer deleted keeps accruing billing state, and the
     * customer-id fallback can resolve to a tombstone instead of a live row.
     */
    const hCtx = await newCtx(browser, "tenant-h", "h");
    const H = await signUpTenant(hCtx.page, "h");
    await block("block 11: the webhook writes to a soft-deleted workspace", async () => {
      await db.company.update({
        where: { id: mine(H.companyId) },
        data: { deletedAt: new Date() },
      });
      const res = await deliver(
        subEvent("subscription_created", {
          companyId: H.companyId,
          status: "active",
          subId: SUB(70),
          customerId: CUST(70),
          renewsAt: isoIn(30),
        })
      );
      const row = await billingRow(H.companyId);
      if (row.plan === "team" && row.deletedAt) {
        fail(
          "[BILL-011] a tombstoned workspace was upgraded to Team",
          `status ${res.status}; deletedAt=${row.deletedAt.toISOString()} plan=${row.plan}`
        );
      } else {
        ok("the webhook skipped the tombstoned workspace");
      }

      // ...and the customer-id fallback finds it too.
      const res2 = await deliver(
        subEvent("subscription_updated", {
          companyId: H.companyId,
          status: "past_due",
          subId: SUB(70),
          customerId: CUST(70),
          renewsAt: isoIn(30),
          omitCustomData: true,
        })
      );
      const row2 = await billingRow(H.companyId);
      if (row2.subscriptionStatus === "past_due") {
        fail(
          "[BILL-011] resolveCompanyId's billingCustomerId fallback resolves a tombstone",
          `status ${res2.status}; subscriptionStatus=${row2.subscriptionStatus}`
        );
      } else {
        ok("the fallback skipped the tombstoned workspace");
      }
    });

    /* ══ BLOCK 12 — duplicate billingCustomerId, arbitrary resolution ══════
     * [BILL-012] There is no unique index on billingCustomerId and
     * resolveCompanyId uses findFirst with NO orderBy. One LemonSqueezy
     * customer who buys for two workspaces (same email, two companies — the
     * normal agency / serial-founder case) leaves two rows carrying the same
     * customer id, and an event without custom_data lands on whichever row
     * Postgres happens to return.
     */
    const iCtx = await newCtx(browser, "tenant-i", "i");
    const I = await signUpTenant(iCtx.page, "i");
    const jCtx = await newCtx(browser, "tenant-j", "j");
    const J = await signUpTenant(jCtx.page, "j");
    await block("block 12: one customer id on two workspaces resolves arbitrarily", async () => {
      const shared = CUST(80);
      await deliver(
        subEvent("subscription_created", {
          companyId: I.companyId,
          status: "active",
          subId: SUB(80),
          customerId: shared,
          renewsAt: isoIn(30),
        })
      );
      await deliver(
        subEvent("subscription_created", {
          companyId: J.companyId,
          status: "active",
          subId: SUB(81),
          customerId: shared,
          renewsAt: isoIn(30),
        })
      );
      const [i0, j0] = [await billingRow(I.companyId), await billingRow(J.companyId)];
      if (i0.billingCustomerId === String(shared) && j0.billingCustomerId === String(shared)) {
        ok("two of my workspaces now carry the same billingCustomerId (no unique index)");
      } else {
        return fail("setup for the ambiguous-resolution test", JSON.stringify({ i0, j0 }));
      }

      // An event with NO custom_data, cancelling ONLY subscription SUB(81) (J's).
      await deliver(
        subEvent("subscription_expired", {
          companyId: J.companyId, // builder only; custom_data is omitted
          status: "expired",
          subId: SUB(81),
          customerId: shared,
          endsAt: isoIn(-1),
          omitCustomData: true,
        })
      );
      const [i1, j1] = [await billingRow(I.companyId), await billingRow(J.companyId)];
      if (i1.plan === "free") {
        fail(
          "[BILL-012] an expiry for subscription " +
            SUB(81) +
            " downgraded the WRONG workspace",
          `I (subscription ${SUB(80)}, still active) plan=${i1.plan}; J plan=${j1.plan}`
        );
      } else if (j1.plan === "free") {
        ok("the ambiguous lookup happened to resolve the right workspace this time");
        note(
          "findFirst has no orderBy — this is luck, not correctness. " +
            `I=${i1.plan} J=${j1.plan}`
        );
      } else {
        fail("neither workspace was downgraded", JSON.stringify({ i1, j1 }));
      }

      // Whichever it picked, the subscription id it wrote is the giveaway.
      if (i1.billingSubscriptionId === String(SUB(81))) {
        fail(
          "[BILL-012] workspace I's billingSubscriptionId was overwritten with J's subscription",
          `${SUB(80)} -> ${i1.billingSubscriptionId}`
        );
      }
    });

    /* ══ BLOCK 13 — a downgrade revokes nothing [BILL-013] ═════════════════
     * `plan` gates exactly one thing in the whole codebase:
     * memberLimitForPlan() inside inviteUserAction. So Team -> free leaves an
     * over-cap workspace fully functional forever, and an invite ISSUED while
     * paid can still be ACCEPTED after the downgrade (acceptInviteAction never
     * re-checks the cap). One month of Team buys unlimited seats permanently.
     */
    const kCtx = await newCtx(browser, "tenant-k", "k");
    const K = await signUpTenant(kCtx.page, "k");
    await block("block 13: downgrading from Team revokes nothing", async () => {
      await deliver(
        subEvent("subscription_created", {
          companyId: K.companyId,
          status: "active",
          subId: SUB(90),
          customerId: CUST(90),
          renewsAt: isoIn(30),
        })
      );
      await signIn(kCtx.page, K.email, K.password);

      // Two invites while paid: one accepted before the downgrade, one after.
      const k1 = `qa-bill-k1-${STAMP}@founderflow.test`;
      const k2 = `qa-bill-k2-${STAMP}@founderflow.test`;
      const k1Pw = `QaBillK1${STAMP}!x`;
      const k2Pw = `QaBillK2${STAMP}!x`;
      await submitInvite(kCtx.page, { name: `QA K1 ${STAMP}`, email: k1, role: "member" });
      await submitInvite(kCtx.page, { name: `QA K2 ${STAMP}`, email: k2, role: "member" });
      const r1 = await inviteRow(K.companyId, k1);
      const r2 = await inviteRow(K.companyId, k2);
      if (!r1 || !r2) return fail("two invites on the Team plan", JSON.stringify({ r1, r2 }));
      ok("Team plan issued 2 invites past the free cap of 2 members");

      const k1Ctx = await newCtx(browser, "invitee-k1", "k1");
      await acceptInvite(k1Ctx.page, r1.token, k1Pw);

      // The subscription lapses.
      await deliver(
        subEvent("subscription_expired", {
          companyId: K.companyId,
          status: "expired",
          subId: SUB(90),
          customerId: CUST(90),
          endsAt: isoIn(-1),
        })
      );
      const row = await billingRow(K.companyId);
      if (row.plan !== "free") return fail("downgrade", `plan is ${row.plan}`);
      ok("tenant K is back on the free plan");

      // 1. The over-cap roster survives.
      const active = await db.user.count({
        where: { companyId: mine(K.companyId), deletedAt: null },
      });
      if (active > 2) {
        fail(
          "[BILL-013] a free workspace holds more active members than the plan allows",
          `${active} active users in ${K.companyId}; FREE_MEMBER_LIMIT is 2, and nothing ` +
            "anywhere revokes, suspends or flags the surplus"
        );
      } else {
        ok(`the downgrade reduced the roster to ${active}`);
      }

      // 2. The surplus member can still sign in and use the app.
      const k1Login = await newCtx(browser, "k1-after", "k1b");
      const signedIn = await signIn(k1Login.page, k1, k1Pw);
      await k1Login.page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0" }).catch(() => {});
      if (signedIn && /\/tasks/.test(k1Login.page.url())) {
        fail(
          "[BILL-013] a member over the free cap still signs in and uses the app",
          `${k1} reached ${k1Login.page.url()} on a free workspace with ${active} members`
        );
      } else {
        ok("the surplus member is locked out after the downgrade");
      }

      // 3. An invite issued while paid is still redeemable after the downgrade.
      const k2Ctx = await newCtx(browser, "invitee-k2", "k2");
      const acc = await acceptInvite(k2Ctx.page, r2.token, k2Pw);
      const k2Row = await db.user.findFirst({
        where: { companyId: mine(K.companyId), email: k2 },
        select: { id: true },
      });
      if (k2Row) {
        fail(
          "[BILL-013] an invite issued on Team was redeemed after the downgrade to free",
          `acceptInviteAction never calls memberLimitForPlan(); ${k2} joined ${K.companyId} ` +
            `(url ${acc.url})`
        );
      } else {
        ok("the stale invite was refused after the downgrade");
      }

      // 4. But the forward gate does still work, so the state is simply
      //    inconsistent rather than uniformly permissive.
      const toast = await submitInvite(kCtx.page, {
        name: `QA K3 ${STAMP}`,
        email: `qa-bill-k3-${STAMP}@founderflow.test`,
        role: "member",
      });
      if (/limited to 2 members/i.test(toast)) {
        ok(`a NEW invite is refused on free: "${toast}"`);
      } else {
        fail("the free-plan cap did not refuse a new invite", `toast="${toast}"`);
      }

      await gotoSettings(kCtx.page);
      const sec = await planSection(kCtx.page);
      await shot(kCtx.page, "13-downgraded-overcap");
      if (sec && /Up to 2 members/i.test(sec.text)) {
        note(`/settings tells the admin "Up to 2 members" while the workspace holds ${active}`);
      }
    });

    /* ══ BLOCK 14 — concurrent invites race the seat cap [BILL-014] ════════
     * The cap is a read-then-write with no transaction and no constraint:
     * `user.count` + `inviteToken.count`, then `inviteToken.create`. Two
     * submissions that interleave both see room.
     */
    const lCtx = await newCtx(browser, "tenant-l", "l");
    const L = await signUpTenant(lCtx.page, "l");
    await block("block 14: two concurrent invites both pass the free seat cap", async () => {
      await signIn(lCtx.page, L.email, L.password);
      const p2 = await lCtx.ctx.newPage();
      await p2.setExtraHTTPHeaders({ "x-real-ip": IP("l") });
      await p2.setViewport({ width: 1440, height: 1100 });
      wire(p2, "tenant-l-2");

      const e1 = `qa-bill-l1-${STAMP}@founderflow.test`;
      const e2 = `qa-bill-l2-${STAMP}@founderflow.test`;
      const [t1, t2] = await Promise.all([
        submitInvite(lCtx.page, { name: `QA L1 ${STAMP}`, email: e1, role: "member" }),
        submitInvite(p2, { name: `QA L2 ${STAMP}`, email: e2, role: "member" }),
      ]);
      const pending = await db.inviteToken.count({
        where: { companyId: mine(L.companyId), usedAt: null },
      });
      // 1 active owner + the cap of 2 means exactly ONE pending invite is legal.
      if (pending > 1) {
        fail(
          "[BILL-014] concurrent invites both passed the free seat cap",
          `${pending} pending invites in ${L.companyId} (1 owner + cap 2 allows 1). ` +
            `toasts: "${t1}" / "${t2}"`
        );
      } else {
        ok(`the cap held under a concurrent double-submit (${pending} pending)`);
      }
      await p2.close().catch(() => {});
    });

    /* ══ BLOCK 15 — status text is data, not markup [negative result NR2] ══
     * subscriptionStatus is written raw from the payload and rendered into the
     * badge. Confirm React escapes it AND that a junk status cannot reach the
     * badge at all (the badge needs plan==="team", which needs an exact member
     * of PAID_STATUSES), and that `plan` can only ever be the two literals.
     */
    await block("block 15: an injected status can neither render nor set plan", async () => {
      const evil = '"><img src=x onerror=window.__qa_xss=1>';
      await deliver(
        subEvent("subscription_updated", {
          companyId: D.companyId,
          status: evil,
          subId: SUB(100),
          customerId: CUST(100),
          renewsAt: isoIn(30),
        })
      );
      const row = await billingRow(D.companyId);
      if (row.plan === "free") ok("an unknown status maps to plan=free, never to the raw string");
      else fail("plan was written from an unknown status", JSON.stringify(row));
      if (row.subscriptionStatus === evil) {
        note("the raw status string is stored verbatim (unvalidated, unbounded)");
      }

      await signIn(dCtx.page, D.email, D.password);
      await gotoSettings(dCtx.page);
      const sec = await planSection(dCtx.page);
      const fired = await dCtx.page.evaluate(() => Boolean(window.__qa_xss));
      if (!fired && sec && !/<img/i.test(sec.html ?? "")) {
        ok("the injected status neither executed nor reached the DOM as markup");
      } else {
        fail("stored status is rendered as markup", `xss=${fired}`);
      }
      // ...and the badge is unreachable on a free plan anyway.
      if (sec && /Solo/.test(sec.text) && !new RegExp("onerror").test(sec.text)) {
        ok("the status badge is gated on plan=team, so a junk status never displays");
      }
    });

    /* ══ BLOCK 16 — the unconfigured deployment, and role gating ═══════════
     * [BILL-015 / negative result NR3] With no API key the Plan section must
     * say so rather than offer a button that cannot work; and the section is
     * admin-only, which is correct — and is also why a cofounder cannot fix
     * billing when the sole admin is gone.
     */
    await block("block 16: unconfigured billing + admin-only Plan section", async () => {
      await gotoSettings(aCtx.page);
      const sec = await planSection(aCtx.page);
      await shot(aCtx.page, "16-plan-unconfigured");
      if (!sec) return fail("Plan & billing section", "missing for the admin");
      if (/isn't set up on this deployment/i.test(sec.text)) {
        ok("with no LEMONSQUEEZY_API_KEY the section says billing is not set up");
        if (sec.buttons.some((b) => /upgrade|manage billing/i.test(b))) {
          fail("an inert Upgrade/Manage button is offered while unconfigured", JSON.stringify(sec.buttons));
        } else {
          ok("no Upgrade / Manage button is offered while unconfigured");
        }
        note(
          "checkout + portal round-trips are NOT observable on this deployment " +
            "(LEMONSQUEEZY_API_KEY / STORE_ID / VARIANT_ID_TEAM unset)"
        );
      } else {
        note(`billing appears configured here; section reads ${JSON.stringify(sec.text)}`);
      }

      // Role gating: invite a cofounder into tenant A and check /settings.
      await signIn(aCtx.page, A.email, A.password);
      const coEmail = `qa-bill-a-co-${STAMP}@founderflow.test`;
      const coPw = `QaBillCo${STAMP}!x`;
      await submitInvite(aCtx.page, { name: `QA Cofounder ${STAMP}`, email: coEmail, role: "cofounder" });
      const coRow = await inviteRow(A.companyId, coEmail);
      if (!coRow) return fail("cofounder invite", "no invite row in my tenant");
      const coCtx = await newCtx(browser, "cofounder", "co");
      await acceptInvite(coCtx.page, coRow.token, coPw);
      await gotoSettings(coCtx.page);
      const coSec = await planSection(coCtx.page);
      await shot(coCtx.page, "16-cofounder-settings");
      if (coSec === null) {
        ok("a cofounder sees no Plan & billing section (admin-only, as designed)");
        note(
          "[BILL-016] the flip side: a cofounder cannot upgrade, cancel or fix a failed " +
            "payment, so a workspace whose only admin is deactivated can never change plan"
        );
      } else {
        fail("a cofounder can see the billing section", JSON.stringify(coSec.text));
      }
    });

    /* ══ BLOCK 17 — an unauthenticated flood of unsigned deliveries ════════
     * [BILL-017] The route is public by design (auth.config.ts allowlists
     * /api/webhooks/), has no rate limiter, and computes the HMAC over the
     * whole body before rejecting it. 512 KB is deliberately modest: the point
     * is that the work is unbounded and unmetered, not to hurt the dev server.
     */
    await block("block 17: the public webhook is unmetered", async () => {
      const big = JSON.stringify({ meta: { event_name: "subscription_created" }, pad: "a".repeat(512 * 1024) });
      const t0 = Date.now();
      const res = await deliver(big, { signature: "a".repeat(64) });
      const ms = Date.now() - t0;
      note(`512 KB unsigned body -> ${res.status} in ${ms} ms`);

      const t1 = Date.now();
      const burst = await Promise.all(
        Array.from({ length: 25 }, () => deliver('{"meta":{}}', { signature: "b".repeat(64) }))
      );
      const codes = [...new Set(burst.map((r) => r.status))];
      note(`25 unsigned deliveries in ${Date.now() - t1} ms -> ${JSON.stringify(codes)}`);
      if (codes.includes(429)) {
        ok("the webhook rate-limits unsigned traffic");
      } else {
        fail(
          "[BILL-017] 25 unsigned deliveries were all served with no rate limiting",
          `statuses ${JSON.stringify(codes)} — each one runs an HMAC over the full body`
        );
      }
    });

    /* ══ BLOCK 18 — non-subscription events are ignored silently ═══════════
     * order_created / subscription_payment_failed / subscription_payment_success
     * are not in SUB_EVENTS. A one-off order grants nothing (correct), but a
     * failed payment tells nobody (block asserts no notification lands in MY
     * tenant), and there is no dunning surface anywhere.
     */
    await block("block 18: payment_failed notifies nobody", async () => {
      await deliver(
        subEvent("subscription_created", {
          companyId: F.companyId,
          status: "active",
          subId: SUB(110),
          customerId: CUST(110),
          renewsAt: isoIn(30),
        })
      );
      const before = await db.notification.count({ where: { companyId: mine(F.companyId) } });
      const res = await deliver({
        meta: { event_name: "subscription_payment_failed", custom_data: { company_id: mine(F.companyId) } },
        data: {
          type: "subscription-invoices",
          id: "inv-1",
          attributes: { subscription_id: SUB(110), status: "failed", customer_id: CUST(110), total: 2900 },
        },
      });
      const after = await db.notification.count({ where: { companyId: mine(F.companyId) } });
      const row = await billingRow(F.companyId);
      if (after === before && row.subscriptionStatus === "active") {
        fail(
          "[BILL-018] a failed payment changed nothing and told nobody",
          `status ${res.status}; subscriptionStatus still "active", ` +
            `${after} notification(s) in ${F.companyId} (was ${before}). ` +
            "The admin learns about the failure from LemonSqueezy's email, if at all."
        );
      } else {
        ok(`payment_failed was handled (status=${row.subscriptionStatus}, notifications ${before}->${after})`);
      }

      // order_created must not grant a plan.
      const gRow0 = await billingRow(G.companyId);
      await deliver({
        meta: { event_name: "order_created", custom_data: { company_id: mine(G.companyId) } },
        data: { type: "orders", id: "ord-1", attributes: { status: "paid", customer_id: CUST(50), total: 2900 } },
      });
      const gRow1 = await billingRow(G.companyId);
      if (gRow1.plan === gRow0.plan && gRow1.subscriptionStatus === gRow0.subscriptionStatus) {
        ok("order_created is ignored and cannot set a plan [negative result NR4]");
      } else {
        fail("order_created mutated the plan", JSON.stringify({ gRow0, gRow1 }));
      }
    });

    /* ══ BLOCK 19 — the plan gate is never cached in the JWT ═══════════════
     * [negative result NR5] `plan` is absent from the token (auth.config.ts
     * jwt callback carries id/companyId/role only), so a webhook-driven
     * upgrade or downgrade takes effect on the customer's NEXT request with no
     * sign-out. Asserted end to end: downgrade E, then the SAME live session
     * is immediately refused a new invite.
     */
    await block("block 19: a downgrade takes effect on the next request, no re-login", async () => {
      await deliver(
        subEvent("subscription_expired", {
          companyId: E.companyId,
          status: "expired",
          subId: SUB(30),
          customerId: CUST(30),
          endsAt: isoIn(-1),
        })
      );
      const row = await billingRow(E.companyId);
      if (row.plan !== "free") return fail("downgrade of tenant E", `plan=${row.plan}`);
      const toast = await submitInvite(eCtx.page, {
        name: `QA E9 ${STAMP}`,
        email: `qa-bill-e9-${STAMP}@founderflow.test`,
        role: "member",
      });
      if (/limited to 2 members/i.test(toast)) {
        ok("the still-open admin session is gated by the NEW plan immediately");
      } else {
        fail("a stale session kept paid capacity after the downgrade", `toast="${toast}"`);
      }
    });
    /* ══ BLOCK 20 — paused / unpaid / unknown statuses [BILL-020] ══════════
     * PAID_STATUSES is an allow-list, so every status outside it drops the
     * workspace to free IMMEDIATELY — including "paused", which in LemonSqueezy
     * means collection is paused with a resume date, and which arrives while
     * the current period is still paid for. That is the mirror image of the
     * `cancelled` hole in block 6: one status over-grants, another under-grants.
     */
    await block("block 20: paused revokes a period the customer already paid for", async () => {
      await deliver(
        subEvent("subscription_created", {
          companyId: I.companyId,
          status: "active",
          subId: SUB(120),
          customerId: CUST(120),
          renewsAt: isoIn(21),
        })
      );
      const paid = await billingRow(I.companyId);
      if (paid.plan !== "team") return fail("setup for the pause test", JSON.stringify(paid));

      await deliver(
        subEvent("subscription_paused", {
          companyId: I.companyId,
          status: "paused",
          subId: SUB(120),
          customerId: CUST(120),
          renewsAt: isoIn(21), // the period they paid for has 21 days left
          attrOverrides: { pause: { mode: "void", resumes_at: isoIn(60) } },
        })
      );
      const paused = await billingRow(I.companyId);
      if (
        paused.plan === "free" &&
        paused.currentPeriodEnd &&
        paused.currentPeriodEnd > new Date()
      ) {
        fail(
          "[BILL-020] a paused subscription lost paid access with 21 days still paid for",
          `plan=${paused.plan} currentPeriodEnd=${paused.currentPeriodEnd.toISOString()} ` +
            "(in the future). PAID_STATUSES accepts an already-lapsed \"cancelled\" but " +
            "refuses a still-funded \"paused\"."
        );
      } else {
        ok(`paused resolved to plan=${paused.plan} — access matches the funded period`);
      }

      // "unpaid" must NOT be treated as paid (LemonSqueezy's dunning end state).
      await deliver(
        subEvent("subscription_updated", {
          companyId: I.companyId,
          status: "unpaid",
          subId: SUB(120),
          customerId: CUST(120),
          renewsAt: isoIn(21),
        })
      );
      const unpaid = await billingRow(I.companyId);
      if (unpaid.plan === "free") ok('status "unpaid" correctly resolves to the free plan');
      else fail("an unpaid subscription kept the paid plan", JSON.stringify(unpaid));

      // ...but "past_due" IS treated as paid, with no cap on how long.
      await deliver(
        subEvent("subscription_updated", {
          companyId: I.companyId,
          status: "past_due",
          subId: SUB(120),
          customerId: CUST(120),
          renewsAt: isoIn(-60), // the retry window closed two months ago
        })
      );
      const pastDue = await billingRow(I.companyId);
      if (pastDue.plan === "team" && pastDue.currentPeriodEnd < new Date()) {
        fail(
          "[BILL-004] past_due keeps the paid plan with no time limit",
          `plan=team, currentPeriodEnd=${pastDue.currentPeriodEnd.toISOString()} (2 months ago)`
        );
      } else {
        ok(`a long-stale past_due resolved to plan=${pastDue.plan}`);
      }
    });
  } catch (err) {
    fail("qa-billing-and-webhooks threw mid-run", err?.message ?? String(err));
    console.error(err);
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
      } catch (err) {
        console.error(`  cleanup failed for ${companyId}:`, err.message);
      }
    }
    await browser.close().catch(() => {});
    await db.$disconnect();
  }

  console.log(`\n  ${passes} assertion(s) passed`);
  console.log(`  screenshots: ${OUT}`);
  console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
}

/** Flip the low nibble of the first byte of a hex digest. */
function flipHexByte(hex) {
  const first = parseInt(hex.slice(0, 2), 16) ^ 0x01;
  return first.toString(16).padStart(2, "0") + hex.slice(2);
}

main().catch((err) => {
  console.error("\u274c qa-billing-and-webhooks threw:", err);
  process.exit(1);
});
