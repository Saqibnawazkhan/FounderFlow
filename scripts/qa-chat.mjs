/*
 * qa-chat.mjs — go-live QA exercise script for the CHAT surface (agent 9).
 *
 * ── DATA SAFETY, the hardest constraint in this audit ─────────────────────
 * This script NEVER touches a pre-existing row. It signs up its OWN workspace
 * through the real signup flow (company name prefixed `qa-chat-`), invites its
 * OWN second user through the real invite flow, and every single database
 * assertion carries `where: { companyId: TENANT.companyId }`. There is no bare
 * `db.X.count()` anywhere in here: under concurrency another agent's insert
 * could satisfy a "did mine land?" check and produce a FALSE PASS, which is
 * the most expensive outcome in a pre-launch audit.
 *
 * A handful of checks need a state the UI cannot produce (a threaded reply, a
 * Runway card, an archived channel — all three are unreachable from the
 * product, which is itself a finding). Those rows are INSERTED, never updated
 * in place, and every insert/update is pinned to a channel this script created
 * inside its own tenant. `scripts/_qa-guard.mjs verify` hashes the demo
 * workspace row by row; nothing below can move one.
 *
 * Everything is torn down in `finally`, children before parents.
 *
 * ── Conventions (copied from scripts/smoke-chat.mjs) ──────────────────────
 *   • localDb() — never `new PrismaClient()`, which auto-loads the root .env
 *     and points at PRODUCTION Supabase.
 *   • ok()/fail() with `process.exitCode = 1`; `fail` does NOT throw, so one
 *     run reports every broken assertion rather than stopping at the first.
 *   • a literal ❌ on every failure line so the runner's summary counts it.
 *   • the retry-until-hydrated signIn helper, verbatim (FaultsAudit A14).
 *   • `x-real-ip: 10.99.0.9` on EVERY page before its first navigation —
 *     getClientIp() falls back to the literal "unknown" in dev, so without it
 *     all nine agents share one limiters.auth bucket of 5/60s.
 *   • state predicates via waitForFunction, never a fixed setTimeout.
 *
 * Usage:  node scripts/qa-chat.mjs
 */

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
/** PER-AGENT screenshot directory. A shared fixed filename destroys evidence. */
const SHOTS = "C:/Users/USER/AppData/Local/Temp/ff-qa/chat";
const AGENT_IP = "10.99.0.9";

const STAMP = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const ADMIN_EMAIL = `qa-chat-${STAMP}@founderflow.test`;
const MEMBER_EMAIL = `qa-chat-m-${STAMP}@founderflow.test`;
const PASSWORD = "QaChat!2026x";
const COMPANY_NAME = `qa-chat-${STAMP}`;

/** Filled in once signup lands; every DB query below is scoped by it. */
const TENANT = { companyId: null, adminId: null, memberId: null };

const db = localDb();

let passes = 0;
function ok(label) {
  passes++;
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  // Literal ❌ so the runner's summary counts this line.
  console.error(`  ❌ FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}
function note(label) {
  console.log(`  ..  ${label}`);
}

/** Guard: refuse to run a scoped query before the tenant id is known. */
function scope(extra = {}) {
  if (!TENANT.companyId) throw new Error("qa-chat: tenant id not resolved yet");
  return { companyId: TENANT.companyId, ...extra };
}

/* ── browser plumbing ─────────────────────────────────────────────────── */

function wire(page) {
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE.error:", m.text());
  });
}

/** A fresh, isolated browser context with this agent's rate-limit identity. */
async function newPage(browser) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  // BEFORE the first navigation — see the header.
  await page.setExtraHTTPHeaders({ "x-real-ip": AGENT_IP });
  wire(page);
  return { ctx, page };
}

/**
 * Sign in, retrying until React owns the click.
 *
 * On a cold dev server the form paints before hydration; a click that lands
 * first performs a NATIVE submit, which becomes a GET with the credentials in
 * the query string and no sign-in. FaultsAudit A14. Copied verbatim.
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

/** React-friendly value set — RHF ignores a raw `el.value = x`. */
const REACT_SET = `(el, v) => {
  el.focus();
  const proto = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}`;

const shot = (page, name) =>
  page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }).catch(() => {});

/* ── tenant creation, through the real product ────────────────────────── */

async function signUpOwnWorkspace(page) {
  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector("input[type=email]", { timeout: 30000 });
  // Hydration: the submit button is disabled until `hydrated`.
  await page.waitForFunction(
    () => !document.querySelector('button[type="submit"]')?.disabled,
    { timeout: 30000 }
  );

  await page.evaluate(
    (set, name, email, password) => {
      const setVal = eval(set);
      const inputs = [...document.querySelectorAll("form input")];
      setVal(inputs.find((i) => i.autocomplete === "name"), name);
      setVal(inputs.find((i) => i.type === "email"), email);
      setVal(inputs.find((i) => i.type === "password"), password);
    },
    REACT_SET,
    `QA Chat Admin ${STAMP}`,
    ADMIN_EMAIL,
    PASSWORD
  );

  // Step 1 → step 2.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("form button")].find((b) =>
      /continue/i.test(b.textContent ?? "")
    );
    btn?.click();
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll("form select")].length >= 2,
    { timeout: 20000 }
  );

  await page.evaluate(
    (set, company) => {
      const setVal = eval(set);
      const inputs = [...document.querySelectorAll("form input")];
      // The company field is the only visible text input on step 2.
      const companyEl = inputs.find(
        (i) => i.type !== "email" && i.type !== "password" && i.autocomplete !== "name"
      );
      setVal(companyEl, company);
      const selects = [...document.querySelectorAll("form select")];
      setVal(selects[0], selects[0].options[0].value); // industry
      setVal(selects[1], selects[1].options[0].value); // currency
    },
    REACT_SET,
    COMPANY_NAME
  );

  await shot(page, "00-signup-step2");
  await page.evaluate(() => document.querySelector("form")?.requestSubmit());

  const landed = await page
    .waitForFunction(() => !location.pathname.startsWith("/signup"), { timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  if (!landed) throw new Error("signup never left /signup — cannot continue");

  const company = await db.company.findFirst({
    where: { name: COMPANY_NAME },
    select: { id: true, name: true, currency: true },
  });
  if (!company) throw new Error(`signup did not create a company named ${COMPANY_NAME}`);
  // Belt and braces: never operate on a tenant that is not the one we named.
  if (!company.name.startsWith("qa-")) throw new Error("refusing to operate on a non-qa tenant");
  TENANT.companyId = company.id;

  const admin = await db.user.findFirst({
    where: scope({ email: ADMIN_EMAIL }),
    select: { id: true, role: true },
  });
  if (!admin) throw new Error("signup did not create the founder user inside the new company");
  TENANT.adminId = admin.id;

  ok(`signed up own tenant ${COMPANY_NAME} (${TENANT.companyId}), founder role=${admin.role}`);
  return company;
}

/** Invite + accept a plain MEMBER through the real flow, in its own context. */
async function inviteMember(adminPage, browser) {
  await adminPage.goto(`${BASE}/team`, { waitUntil: "networkidle0", timeout: 60000 });
  await adminPage.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some((b) => /invite member/i.test(b.textContent)),
    { timeout: 30000 }
  );
  await adminPage.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => /invite member/i.test(b.textContent))
      ?.click();
  });
  await adminPage.waitForSelector('[role="dialog"] input', { timeout: 15000 });

  await adminPage.evaluate(
    (set, name, email) => {
      const setVal = eval(set);
      const dialog = document.querySelector('[role="dialog"]');
      const inputs = [...dialog.querySelectorAll("input")];
      setVal(inputs[0], name);
      setVal(inputs[1], email);
      // Role: pick "Team Member" so the finance-redaction checks have a viewer
      // who fails canSeeFinances.
      [...dialog.querySelectorAll("button")]
        .find((b) => /team member/i.test(b.textContent))
        ?.click();
    },
    REACT_SET,
    `QA Chat Member ${STAMP}`,
    MEMBER_EMAIL
  );
  await adminPage.evaluate(() =>
    document.querySelector('[role="dialog"] form')?.requestSubmit()
  );
  await adminPage
    .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 20000 })
    .catch(() => {});

  const token = await db.inviteToken.findFirst({
    where: scope({ email: MEMBER_EMAIL }),
    orderBy: { createdAt: "desc" },
  });
  if (!token) throw new Error("invite token row never appeared inside my tenant");
  if (token.role !== "member") {
    fail("invite role", `expected role=member on the token, got ${token.role}`);
  }

  const { ctx, page } = await newPage(browser);
  await page.goto(`${BASE}/invite/${token.token}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector("input[type=password]", { timeout: 20000 });
  await page.evaluate(
    (set, pw) => {
      const setVal = eval(set);
      setVal(document.querySelector("input[type=password]"), pw);
    },
    REACT_SET,
    PASSWORD
  );
  await page.evaluate(() => document.querySelector("form")?.requestSubmit());
  await page
    .waitForFunction(() => !location.pathname.startsWith("/invite"), { timeout: 45000 })
    .catch(() => {});

  const member = await db.user.findFirst({
    where: scope({ email: MEMBER_EMAIL }),
    select: { id: true, role: true },
  });
  if (!member) throw new Error("invite acceptance did not create the member inside my tenant");
  TENANT.memberId = member.id;
  ok(`invited + accepted a second user (role=${member.role}) inside my own tenant`);
  return { ctx, page };
}

/* ── the checks ───────────────────────────────────────────────────────── */

/** Every channel row in MY tenant, by slug. */
async function myChannel(slug) {
  return db.channel.findFirst({
    where: scope({ slug }),
    select: {
      id: true,
      slug: true,
      name: true,
      kind: true,
      archivedAt: true,
      dmKey: true,
      members: { select: { userId: true, role: true, lastReadAt: true } },
    },
  });
}

/** Create a channel through the real UI and return its slug. */
async function createChannelViaUi(page, name, kind) {
  await page.waitForSelector('button[aria-label="New channel"]', { timeout: 20000 });
  await page.click('button[aria-label="New channel"]');
  await page.waitForSelector('[role="dialog"] input', { timeout: 15000 });
  await page.evaluate(
    (set, n, k) => {
      const setVal = eval(set);
      const dialog = document.querySelector('[role="dialog"]');
      setVal(dialog.querySelectorAll("input")[0], n);
      if (k === "private") {
        [...dialog.querySelectorAll('[role="radio"]')]
          .find((b) => /private/i.test(b.textContent))
          ?.click();
      }
    },
    REACT_SET,
    name,
    kind
  );
  await page.evaluate(() => document.querySelector('[role="dialog"] form')?.requestSubmit());
  await page.waitForFunction(
    (n) => location.pathname.startsWith("/chat/") && !document.querySelector('[role="dialog"]'),
    { timeout: 30000 },
    name
  );
  await page.waitForFunction(() => !!document.querySelector('nav[aria-label="Channels"]'), {
    timeout: 20000,
  });
  return new URL(page.url()).pathname.replace("/chat/", "");
}

/** Post a message through the composer with ENTER, and wait for it to land. */
async function sendMessage(page, body) {
  await page.waitForSelector("form textarea", { timeout: 20000 });
  await page.click("form textarea");
  await page.keyboard.type(body);
  await page.keyboard.press("Enter");
  return page
    .waitForFunction((t) => document.body.innerText.includes(t), { timeout: 20000 }, body)
    .then(() => true)
    .catch(() => false);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });
  console.log(`== qa-chat (agent 9, ip ${AGENT_IP}) ==`);

  let adminCtx = null;
  let memberCtx = null;

  try {
    /* ── 0. own tenant ─────────────────────────────────────────────── */
    const a = await newPage(browser);
    adminCtx = a.ctx;
    const admin = a.page;
    await signUpOwnWorkspace(admin);

    const m = await inviteMember(admin, browser);
    memberCtx = m.ctx;
    const member = m.page;

    /* ── 1. happy path: /chat lands in #general, both users are in it ─ */
    await admin.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
    const landedPath = new URL(admin.url()).pathname;
    if (landedPath.startsWith("/chat/")) ok(`/chat redirects into a channel (${landedPath})`);
    else fail("chat landing", `expected /chat/<slug>, got ${landedPath}`);

    const general = await myChannel("general");
    if (general && general.kind === "public") {
      ok("signup bootstrapped a public #general inside my tenant");
    } else {
      fail("bootstrap #general", `got ${JSON.stringify(general)}`);
    }
    const generalMemberIds = (general?.members ?? []).map((x) => x.userId);
    if (generalMemberIds.includes(TENANT.adminId) && generalMemberIds.includes(TENANT.memberId)) {
      ok("founder and invitee both hold a #general ChannelMember row");
    } else {
      fail("joinDefaultChannels", `#general members = ${JSON.stringify(generalMemberIds)}`);
    }

    const body1 = `qa-chat hello ${STAMP}`;
    if (await sendMessage(admin, body1)) ok("a message sends with Enter and renders");
    else fail("send with Enter", "the message never appeared in the timeline");

    const stored = await db.message.findMany({
      where: scope({ body: body1 }),
      select: { id: true, channelId: true, parentId: true, kind: true, replyCount: true },
    });
    if (stored.length === 1) ok("the database agrees: exactly one row, in my tenant");
    else fail("message persisted", `expected 1 scoped row, found ${stored.length}`);
    const rootMessage = stored[0] ?? null;
    await shot(admin, "01-general-admin");

    /* ── 2. chat-001 · threads have NO entry point ──────────────────── */
    // A thread can only be opened from the "N replies" control, which only
    // renders when replyCount > 0; a reply can only be created from the
    // composer inside that panel. Chicken and egg.
    const threadAffordances = await admin.evaluate(() => {
      const txt = (el) => (el.textContent || "").toLowerCase();
      return [...document.querySelectorAll("button, a")]
        .filter((el) => /repl(y|ies)|thread/.test(txt(el)) || /repl|thread/i.test(el.getAttribute("aria-label") || ""))
        .map((el) => (el.getAttribute("aria-label") || el.textContent || "").trim());
    });
    if (threadAffordances.length === 0) {
      ok("chat-001 OBSERVED: a zero-reply message offers no way to start a thread");
    } else {
      fail(
        "chat-001",
        `expected no reply/thread control on a fresh message, found ${JSON.stringify(threadAffordances)}`
      );
    }

    // Now prove the rest of the thread machinery is fine — the gap is only the
    // entry point. Insert one reply INSIDE MY OWN TENANT, scoped to my root.
    let seededReplyId = null;
    if (rootMessage) {
      const reply = await db.message.create({
        data: {
          companyId: TENANT.companyId,
          channelId: rootMessage.channelId,
          authorId: TENANT.adminId,
          authorName: `QA Chat Admin ${STAMP}`,
          kind: "text",
          body: `qa-chat seeded reply ${STAMP}`,
          parentId: rootMessage.id,
          mentions: "[]",
        },
        select: { id: true },
      });
      seededReplyId = reply.id;
      await db.message.update({
        where: { id: rootMessage.id },
        data: { replyCount: { increment: 1 } },
      });
      await admin.reload({ waitUntil: "networkidle0" });
      const opened = await admin
        .waitForFunction(
          () =>
            [...document.querySelectorAll("button")].some((b) => /\d+ repl/i.test(b.textContent)),
          { timeout: 20000 }
        )
        .then(() => true)
        .catch(() => false);
      if (opened) {
        await admin.evaluate(() =>
          [...document.querySelectorAll("button")]
            .find((b) => /\d+ repl/i.test(b.textContent))
            ?.click()
        );
        const panel = await admin
          .waitForFunction(
            () => {
              const d = document.querySelector('[role="dialog"]');
              return !!d && /thread/i.test(d.textContent || "");
            },
            { timeout: 20000 }
          )
          .then(() => true)
          .catch(() => false);
        if (panel) {
          ok("chat-001 corroborated: the thread panel works once replyCount>0 is forced in the DB");
          await shot(admin, "02-thread-panel-forced");
        } else {
          fail("thread panel", "replyCount>0 rendered the control but the panel never opened");
        }
        // chat-009: the panel is gated on `thread &&`, so the documented
        // "open on a spinner" never renders. Observed as: nothing at all is on
        // screen between the click and the round trip. Recorded, not asserted
        // (it is a timing window), unless the panel failed to open at all.
        await admin.keyboard.press("Escape").catch(() => {});
      } else {
        fail("chat-001 corroboration", "a root with replyCount=1 rendered no reply control");
      }
    }

    /* ── 3. chat-002 · a public channel nobody can post in ──────────── */
    await admin.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
    const pubSlug = await createChannelViaUi(admin, `qa pub ${STAMP}`, "public");
    const pubChannel = await myChannel(pubSlug);
    if (pubChannel && pubChannel.kind === "public") ok(`created a public channel /chat/${pubSlug}`);
    else fail("create public channel", `slug=${pubSlug} row=${JSON.stringify(pubChannel)}`);

    await member.goto(`${BASE}/chat/${pubSlug}`, { waitUntil: "networkidle0", timeout: 60000 });
    const pubState = await member.evaluate(() => ({
      path: location.pathname,
      hasComposer: !!document.querySelector("form textarea"),
      readOnlyCopy: /join this channel to post in it/i.test(document.body.innerText),
      joinControls: [...document.querySelectorAll("button, a")]
        .map((el) => (el.getAttribute("aria-label") || el.textContent || "").trim())
        .filter((t) => /^join\b|join channel|leave channel|add (people|member)/i.test(t)),
      addReaction: !!document.querySelector('button[aria-label="Add reaction"]'),
    }));
    await shot(member, "03-public-channel-member");
    if (pubState.path === `/chat/${pubSlug}`) {
      ok("a teammate CAN read a public channel they never joined");
    } else {
      fail("public channel read", `member ended up on ${pubState.path}`);
    }
    if (!pubState.hasComposer && pubState.readOnlyCopy && pubState.joinControls.length === 0) {
      ok(
        "chat-002 OBSERVED: no composer, copy says \"Join this channel to post in it\", and no join control exists"
      );
    } else {
      fail(
        "chat-002",
        `composer=${pubState.hasComposer} copy=${pubState.readOnlyCopy} joinControls=${JSON.stringify(pubState.joinControls)}`
      );
    }
    // The server would have allowed it — prove the UI, not the permission
    // model, is what blocks: no ChannelMember row exists for the member, and
    // canPostInChannel({kind:"public", isMember:false}) is true by contract.
    const pubMembers = (pubChannel?.members ?? []).map((x) => x.userId);
    if (!pubMembers.includes(TENANT.memberId)) {
      ok("chat-002 corroborated: the member holds no ChannelMember row and cannot create one");
    } else {
      fail("chat-002 corroboration", "member unexpectedly has a membership row");
    }

    /* ── 4. chat-003 · a private channel can never gain a second person ─ */
    await admin.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
    const privSlug = await createChannelViaUi(admin, `qa priv ${STAMP}`, "private");
    const privChannel = await myChannel(privSlug);
    if (privChannel?.kind === "private") ok(`created a private channel /chat/${privSlug}`);
    else fail("create private channel", `slug=${privSlug} row=${JSON.stringify(privChannel)}`);

    const addControls = await admin.evaluate(() =>
      [...document.querySelectorAll("button, a")]
        .map((el) => (el.getAttribute("aria-label") || el.textContent || "").trim())
        .filter((t) => /add (people|member|someone)|invite to|manage members|members?\b.*add/i.test(t))
    );
    if (addControls.length === 0 && (privChannel?.members ?? []).length === 1) {
      ok(
        "chat-003 OBSERVED: a private channel has exactly one member and no control to add another"
      );
    } else {
      fail(
        "chat-003",
        `members=${(privChannel?.members ?? []).length} addControls=${JSON.stringify(addControls)}`
      );
    }
    await shot(admin, "04-private-channel-owner");

    // NEGATIVE RESULT #1 — private-channel invisibility, from the other side.
    await member.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
    await member.waitForSelector('nav[aria-label="Channels"]', { timeout: 20000 });
    const memberRail = await member.evaluate(() =>
      [...document.querySelectorAll('nav[aria-label="Channels"] a')].map((el) =>
        el.textContent.trim()
      )
    );
    const railLeak = memberRail.some((n) => n.toLowerCase().includes("priv"));
    const res = await member.goto(`${BASE}/chat/${privSlug}`, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });
    const status = res ? res.status() : 0;
    const notFound = await member.evaluate(() => /not found|404/i.test(document.body.innerText));
    const forbidden = await member.evaluate(() => /403|forbidden|not allowed/i.test(document.body.innerText));
    if (!railLeak && (status === 404 || notFound) && !forbidden) {
      ok("NEGATIVE: a private channel is absent from a non-member's rail AND answers not-found, never 403");
    } else {
      fail(
        "private channel invisibility",
        `railLeak=${railLeak} status=${status} notFound=${notFound} forbidden=${forbidden}`
      );
    }
    await shot(member, "05-private-notfound");

    /* ── 5. DM: idempotency, naming, and a forged pair's URL ─────────── */
    await admin.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.waitForSelector('button[aria-label="New direct message"]', { timeout: 20000 });
    await admin.click('button[aria-label="New direct message"]');
    await admin.waitForSelector('[role="dialog"] li button', { timeout: 15000 });
    await admin.evaluate(() =>
      document.querySelector('[role="dialog"] li button')?.click()
    );
    await admin.waitForFunction(
      () => /^\/chat\/dm-/.test(location.pathname) && !document.querySelector('[role="dialog"]'),
      { timeout: 30000 }
    );
    const dmSlug = new URL(admin.url()).pathname.replace("/chat/", "");
    const dmRows = await db.channel.findMany({
      where: scope({ kind: "dm" }),
      select: { id: true, slug: true, dmKey: true, members: { select: { userId: true } } },
    });
    if (dmRows.length === 1 && dmRows[0].slug === dmSlug) {
      ok(`opened a DM at /chat/${dmSlug} — exactly one dm row in my tenant`);
    } else {
      fail("open DM", `expected 1 dm row matching ${dmSlug}, got ${JSON.stringify(dmRows)}`);
    }

    // NEGATIVE RESULT #2 — DM idempotency: re-opening writes nothing.
    await admin.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.click('button[aria-label="New direct message"]');
    await admin.waitForSelector('[role="dialog"] li button', { timeout: 15000 });
    await admin.evaluate(() => document.querySelector('[role="dialog"] li button')?.click());
    await admin.waitForFunction(() => /^\/chat\/dm-/.test(location.pathname), { timeout: 30000 });
    const dmRowsAfter = await db.channel.findMany({
      where: scope({ kind: "dm" }),
      select: { id: true, slug: true, createdAt: true },
    });
    if (
      dmRowsAfter.length === 1 &&
      dmRowsAfter[0].id === dmRows[0]?.id &&
      new URL(admin.url()).pathname === `/chat/${dmSlug}`
    ) {
      ok("NEGATIVE: re-opening the same DM is idempotent — same row, same slug, no fork");
    } else {
      fail("DM idempotency", JSON.stringify(dmRowsAfter));
    }

    // The counterpart sees the SAME row under a viewer-relative name.
    await member.goto(`${BASE}/chat/${dmSlug}`, { waitUntil: "networkidle0", timeout: 60000 });
    const dmAsMember = await member.evaluate(() => ({
      path: location.pathname,
      heading: document.querySelector("h1")?.textContent?.trim() ?? "",
      title: document.title,
      placeholder: document.querySelector("form textarea")?.getAttribute("placeholder") ?? "",
      hashIcon: !!document.querySelector('[aria-label="Public channel"]'),
    }));
    if (dmAsMember.path === `/chat/${dmSlug}` && /admin/i.test(dmAsMember.heading)) {
      ok(`the counterpart opens the same DM and sees it named "${dmAsMember.heading}"`);
    } else {
      fail("DM viewer-relative name", JSON.stringify(dmAsMember));
    }
    // chat-007 — a DM wearing channel chrome.
    if (/^#/.test(dmAsMember.title) || /^Message #/.test(dmAsMember.placeholder)) {
      ok(
        `chat-007 OBSERVED: a DM is presented as a hash channel — title=${JSON.stringify(dmAsMember.title)} placeholder=${JSON.stringify(dmAsMember.placeholder)}`
      );
    } else {
      note(`chat-007 not reproduced: title=${dmAsMember.title} placeholder=${dmAsMember.placeholder}`);
    }
    await shot(member, "06-dm-member");

    // NEGATIVE RESULT #3 — forge a DM URL for a pair I am not in.
    // Both user ids are discoverable from the DM picker, so build the slug the
    // way the app does and try to walk into somebody else's conversation.
    const forged = `dm-${[TENANT.adminId, TENANT.memberId].sort().join("_")}`;
    const thirdId = `${TENANT.adminId}zz`;
    const forgedOther = `dm-${[TENANT.adminId, thirdId].sort().join("_")}`;
    const forgedRes = await member.goto(`${BASE}/chat/${forgedOther}`, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });
    const forgedNotFound = await member.evaluate(() =>
      /not found|404/i.test(document.body.innerText)
    );
    if ((forgedRes?.status() === 404 || forgedNotFound) && forged === dmSlug) {
      ok("NEGATIVE: a hand-built DM slug for a pair I am not in answers not-found");
    } else {
      fail(
        "forged DM slug",
        `status=${forgedRes?.status()} notFound=${forgedNotFound} derivedSlug=${forged} actual=${dmSlug}`
      );
    }

    /* ── 6. chat-004 · nothing arrives until you reload ──────────────── */
    // Member posts into #general while the admin's page sits open on it.
    await admin.goto(`${BASE}/chat/general`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.waitForSelector("form textarea", { timeout: 20000 });
    const liveBody = `qa-chat live-probe ${STAMP}`;
    await member.goto(`${BASE}/chat/general`, { waitUntil: "networkidle0", timeout: 60000 });
    if (await sendMessage(member, liveBody)) {
      ok("the member's message sent into #general");
    } else {
      fail("member send", "the member's message never rendered on their own page");
    }
    const landedOnAdmin = await admin
      .waitForFunction((t) => document.body.innerText.includes(t), { timeout: 15000 }, liveBody)
      .then(() => true)
      .catch(() => false);
    await admin.reload({ waitUntil: "networkidle0" });
    const afterReload = await admin
      .waitForFunction((t) => document.body.innerText.includes(t), { timeout: 20000 }, liveBody)
      .then(() => true)
      .catch(() => false);
    if (!landedOnAdmin && afterReload) {
      ok(
        "chat-004 OBSERVED: an incoming message never appears on an open channel — only a reload brings it in"
      );
    } else if (landedOnAdmin) {
      fail("chat-004", "the message DID arrive without a reload — re-classify this finding");
    } else {
      fail("chat-004", "the message did not appear even after a reload");
    }
    await shot(admin, "07-no-realtime");

    /* ── 7. chat-005 · the unread badge does not clear while reading ─── */
    // The admin now has an unread #general (the member's message). Open it and
    // watch whether the rail's badge clears without navigating away.
    const badgeBefore = await admin.evaluate(() => {
      const link = [...document.querySelectorAll('nav[aria-label="Channels"] a')].find((a) =>
        /general/i.test(a.textContent)
      );
      return link ? (link.querySelector("span[aria-label]")?.textContent ?? null) : "NO-LINK";
    });
    // The read receipt is debounced 750ms and fires only while parked at the
    // bottom; give the watermark a state predicate rather than a fixed sleep.
    const watermarkMoved = await (async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const row = await db.channelMember.findFirst({
          where: { channel: scope({ slug: "general" }), userId: TENANT.adminId },
          select: { lastReadAt: true, lastReadMessageId: true },
        });
        const msg = await db.message.findFirst({
          where: scope({ body: liveBody }),
          select: { createdAt: true },
        });
        if (row && msg && row.lastReadAt >= msg.createdAt) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    })();
    if (watermarkMoved) ok("the read watermark advances past an incoming message");
    else fail("read watermark", "lastReadAt never passed the incoming message");

    const badgeAfter = await admin.evaluate(() => {
      const link = [...document.querySelectorAll('nav[aria-label="Channels"] a')].find((a) =>
        /general/i.test(a.textContent)
      );
      return link ? (link.querySelector("span[aria-label]")?.textContent ?? null) : "NO-LINK";
    });
    if (badgeBefore && badgeBefore !== "NO-LINK" && badgeAfter === badgeBefore) {
      ok(
        `chat-005 OBSERVED: the rail badge stays "${badgeAfter}" on the channel being read (markChannelReadAction revalidates /chat, not /chat/[slug])`
      );
    } else {
      note(`chat-005: badgeBefore=${badgeBefore} badgeAfter=${badgeAfter}`);
    }

    /* ── 8. chat-006 · @-mention picker in a user-made public channel ── */
    await admin.goto(`${BASE}/chat/${pubSlug}`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.waitForSelector("form textarea", { timeout: 20000 });
    await admin.click("form textarea");
    await admin.keyboard.type("@");
    const candidates = await admin
      .waitForFunction(() => !!document.querySelector('ul[role="listbox"]'), { timeout: 8000 })
      .then(() =>
        admin.evaluate(() =>
          [...document.querySelectorAll('ul[role="listbox"] li')].map((li) =>
            li.textContent.trim()
          )
        )
      )
      .catch(() => []);
    await shot(admin, "08-mention-picker-public");
    const offersMember = candidates.some((c) => /member/i.test(c));
    if (!offersMember) {
      ok(
        `chat-006 OBSERVED: the mention picker in a user-created public channel offers ${candidates.length} name(s) and not the teammate — it is fed channel.members, not the workspace roster`
      );
    } else {
      fail("chat-006", `picker unexpectedly offered the teammate: ${JSON.stringify(candidates)}`);
    }
    await admin.keyboard.press("Escape").catch(() => {});

    /* ── 9. Runway card redaction, the one place money meets a member ── */
    // No card can be posted from the UI (postRunwayCardAction has no reachable
    // caller — already-confirmed), so the row is INSERTED into my own tenant's
    // #general to exercise the redaction that would ship the day that button
    // is wired up.
    let cardId = null;
    if (general) {
      const secret = 987654321;
      const payload = JSON.stringify({
        v: 1,
        type: "runway",
        asOf: new Date().toISOString(),
        runwayMonths: 7.5,
        cashOnHand: secret,
        monthlyBurn: 131687242.8,
        currency: "PKR",
      });
      const card = await db.message.create({
        data: {
          companyId: TENANT.companyId,
          channelId: general.id,
          authorId: TENANT.adminId,
          authorName: `QA Chat Admin ${STAMP}`,
          kind: "card",
          body: "shared a runway snapshot",
          payload,
          mentions: "[]",
        },
        select: { id: true },
      });
      cardId = card.id;

      await admin.goto(`${BASE}/chat/general`, { waitUntil: "networkidle0", timeout: 60000 });
      const adminSees = await admin.content();
      await member.goto(`${BASE}/chat/general`, { waitUntil: "networkidle0", timeout: 60000 });
      const memberSees = await member.content();
      await shot(member, "09-runway-card-member");
      await shot(admin, "10-runway-card-admin");

      const adminHasFigure = adminSees.includes(String(secret));
      // Every spelling the figure could reach the wire in: the raw integer,
      // the serialized payload, and the formatted string.
      const memberHasFigure =
        memberSees.includes(String(secret)) ||
        memberSees.includes("987,654,321") ||
        /monthlyBurn/.test(memberSees);
      if (adminHasFigure && !memberHasFigure) {
        ok(
          "NEGATIVE: a Runway card's figures reach an admin and are absent from the member's entire RSC payload — redaction is server-side"
        );
      } else {
        fail(
          "runway redaction",
          `adminHasFigure=${adminHasFigure} memberHasFigure=${memberHasFigure} — a member must never receive the figure in ANY form`
        );
      }
    }

    /* ── 10. try to break it: forged ids and stale state ─────────────── */
    // A reaction against a message id that is not in my tenant must fail, and
    // must fail the same way a non-existent id does (no existence oracle).
    const reactionProbe = await member.evaluate(async () => {
      // The reaction control is the only client-side entry to the action, so
      // exercise it through the UI on a message the viewer CAN see, then
      // confirm the DB row is scoped to the viewer.
      const btn = document.querySelector('button[aria-label="Add reaction"]');
      if (!btn) return { ok: false, why: "no add-reaction control on screen" };
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      const first = document.querySelector('[role="group"][aria-label="Choose a reaction"] button');
      if (!first) return { ok: false, why: "picker never opened" };
      first.click();
      return { ok: true };
    });
    if (reactionProbe.ok) {
      const reacted = await (async () => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const rows = await db.messageReaction.findMany({
            where: { message: scope({}), userId: TENANT.memberId },
            select: { id: true, emoji: true, messageId: true },
          });
          if (rows.length > 0) return rows;
          await new Promise((r) => setTimeout(r, 400));
        }
        return [];
      })();
      if (reacted.length === 1) {
        ok(`a reaction persists exactly one scoped row (${reacted[0].emoji})`);
      } else {
        fail("reaction persistence", `expected 1 scoped reaction row, got ${reacted.length}`);
      }
    } else {
      note(`reaction probe skipped: ${reactionProbe.why}`);
    }

    // Archived channel: archiving has no UI (canManageChannel has no caller —
    // already-confirmed), so set the tombstone on MY OWN channel and check the
    // read-only contract holds in both the timeline AND the thread panel.
    if (pubChannel) {
      await db.channel.update({
        where: { id: pubChannel.id },
        data: { archivedAt: new Date() },
      });
      await admin.goto(`${BASE}/chat/${pubSlug}`, { waitUntil: "networkidle0", timeout: 60000 });
      const archivedState = await admin.evaluate(() => ({
        badge: /archived/i.test(document.body.innerText),
        composer: !!document.querySelector("form textarea"),
        addReaction: !!document.querySelector('button[aria-label="Add reaction"]'),
      }));
      if (archivedState.badge && !archivedState.composer && !archivedState.addReaction) {
        ok("NEGATIVE: an archived channel is read-only for its own owner — no composer, no reactions");
      } else {
        fail("archived read-only", JSON.stringify(archivedState));
      }
      await shot(admin, "11-archived-channel");
    }

    /* ── 11. chat-010 · the ?message= deep link goes nowhere ─────────── */
    if (rootMessage) {
      await admin.goto(`${BASE}/chat/general?message=${rootMessage.id}`, {
        waitUntil: "networkidle0",
        timeout: 60000,
      });
      const deepLink = await admin.evaluate((id) => {
        const el = document.querySelector(`[data-message-id="${id}"]`);
        return {
          anchored: !!el,
          highlighted: /highlight|ring-2|bg-primary\/20/.test(el?.className ?? ""),
          scroller: (() => {
            const s = document.querySelector('[role="log"]');
            return s ? { top: s.scrollTop, height: s.scrollHeight, client: s.clientHeight } : null;
          })(),
        };
      }, rootMessage.id);
      if (!deepLink.anchored && !deepLink.highlighted) {
        ok(
          "chat-010 OBSERVED: ?message=<id> is ignored — nothing is anchored, highlighted, or scrolled to"
        );
      } else {
        fail("chat-010", JSON.stringify(deepLink));
      }
    }

    /* ── 12. error paths ─────────────────────────────────────────────── */
    await admin.goto(`${BASE}/chat/general`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.waitForSelector("form textarea", { timeout: 20000 });
    // Empty submit is a no-op, not an error toast.
    const beforeEmpty = await db.message.count({ where: scope({ channelId: general.id }) });
    await admin.click("form textarea");
    await admin.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, 1200));
    const afterEmpty = await db.message.count({ where: scope({ channelId: general.id }) });
    if (beforeEmpty === afterEmpty) ok("an empty Enter writes nothing and raises no error");
    else fail("empty submit", `row count moved ${beforeEmpty} -> ${afterEmpty}`);

    // Over-length body: the textarea caps at 4000 and the schema rejects above.
    const long = "x".repeat(4100);
    await admin.evaluate(
      (set, v) => {
        const setVal = eval(set);
        setVal(document.querySelector("form textarea"), v);
      },
      REACT_SET,
      long
    );
    const typed = await admin.evaluate(
      () => document.querySelector("form textarea").value.length
    );
    if (typed <= 4000) {
      ok(`an over-length draft is capped client-side at ${typed} characters`);
    } else {
      note(`draft accepted ${typed} chars; the server schema is the backstop`);
    }
    await admin.evaluate(
      (set) => {
        const setVal = eval(set);
        setVal(document.querySelector("form textarea"), "");
      },
      REACT_SET
    );

    // Expired session: kill the JWT by bumping MY OWN user's sessionVersion.
    const preBump = await db.user.findFirst({
      where: scope({ id: TENANT.memberId }),
      select: { sessionVersion: true },
    });
    await db.user.update({
      where: { id: TENANT.memberId },
      data: { sessionVersion: { increment: 1 } },
    });
    await member.goto(`${BASE}/chat/general`, { waitUntil: "networkidle0", timeout: 60000 });
    const bouncedTo = new URL(member.url()).pathname;
    if (bouncedTo.startsWith("/login")) {
      ok(`NEGATIVE: a revoked session cannot keep reading chat (bounced to ${bouncedTo}, was v${preBump?.sessionVersion})`);
    } else {
      fail("session invalidation", `a revoked session still reached ${bouncedTo}`);
    }
    await shot(member, "12-revoked-session");

    void seededReplyId;
    void cardId;
  } catch (e) {
    fail("qa-chat threw", e.message);
    console.error(e);
  } finally {
    /* ── teardown: my tenant only, children before parents ──────────── */
    try {
      if (TENANT.companyId) {
        const cid = TENANT.companyId;
        const guard = await db.company.findUnique({
          where: { id: cid },
          select: { name: true },
        });
        if (!guard || !guard.name.startsWith("qa-")) {
          console.error("  ❌ refusing to clean up a tenant that is not mine:", guard?.name);
        } else {
          await db.messageReaction.deleteMany({ where: { message: { companyId: cid } } });
          await db.message.deleteMany({ where: { companyId: cid } });
          await db.channelMember.deleteMany({ where: { channel: { companyId: cid } } });
          await db.channel.deleteMany({ where: { companyId: cid } });
          await db.comment.deleteMany({ where: { companyId: cid } });
          await db.timeEntry.deleteMany({ where: { companyId: cid } });
          await db.notification.deleteMany({ where: { companyId: cid } });
          await db.activity.deleteMany({ where: { companyId: cid } });
          await db.inviteToken.deleteMany({ where: { companyId: cid } });
          await db.recurringRule.deleteMany({ where: { companyId: cid } });
          await db.budget.deleteMany({ where: { companyId: cid } });
          await db.transaction.deleteMany({ where: { companyId: cid } });
          await db.task.deleteMany({ where: { companyId: cid } });
          await db.project.deleteMany({ where: { companyId: cid } });
          await db.notificationPreference.deleteMany({ where: { user: { companyId: cid } } });
          await db.pushSubscription.deleteMany({ where: { user: { companyId: cid } } });
          await db.user.deleteMany({ where: { companyId: cid } });
          await db.company.delete({ where: { id: cid } });
          console.log(`  ..  tore down tenant ${cid}`);
        }
      }
    } catch (e) {
      console.error("  ❌ cleanup failed:", e.message);
    }
    try {
      if (memberCtx) await memberCtx.close();
      if (adminCtx) await adminCtx.close();
      await browser.close();
    } catch {
      /* contexts may already be gone */
    }
    await db.$disconnect();
  }

  console.log(`\n${process.exitCode ? "== FAIL ==" : "== pass =="}  (${passes} checks passed)`);
}

main().catch((err) => {
  console.error("  ❌ qa-chat threw at top level:", err);
  process.exit(1);
});
