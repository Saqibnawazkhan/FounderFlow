/*
 * PRIVATE CHANNELS: WHO SEES ONE, AND HOW ANYBODY ELSE GETS INTO IT.
 *
 * Reported from the running product, with a screenshot: a private channel
 * called "new" "stays visible to everyone" and "i cannot pick and choose who to
 * add". Two claims, and they need two different kinds of proof.
 *
 * THE VISIBILITY CLAIM IS THE URGENT ONE and it cannot be settled by reading
 * the code from the reporter's own account, because the creator of a channel IS
 * a member of it — the one viewer for whom "visible" is correct. It can only be
 * settled by signing in as somebody else. So this script runs THREE accounts
 * against one channel:
 *
 *   • its creator      — sees it (correct, and the thing the reporter saw)
 *   • a member added through the UI — sees it and can post in it
 *   • a third teammate who was never added — must NOT see it in the rail, must
 *     NOT find its name anywhere on the page, and must get a 404 (not a 403)
 *     when they type the URL, because a 403 would confirm that a channel called
 *     #layoffs exists
 *
 * THE MEMBERSHIP CLAIM is exercised the way a user would: create the channel
 * from the rail's "+", tick a name in the "Add people" dialog, and read the
 * member count back off the header. Two residual defects this run also covers:
 *
 *   chat-003 (residual) — the client drew "Add people" only for
 *     `myChannelRole === "owner"`, a NARROWER copy of the server's
 *     `canManageChannel`, which also admits an admin or cofounder. Since there
 *     is no other membership write in the product, a cofounder invited into a
 *     private channel could never add a third person to it. Phase 4 signs in as
 *     the seeded cofounder and looks for the control.
 *
 *   chat-006 — the @-mention picker was fed `channel.members`. In a PUBLIC
 *     channel the server parses mentions against the whole live company roster
 *     and skips the membership filter entirely, so a freshly created public
 *     channel offered one name while the server stood ready to notify the whole
 *     workspace. Phase 5 types "@" into a brand-new public channel and reads the
 *     listbox.
 *
 * WHAT THIS TOUCHES. It signs in as seeded users only, and the only rows it
 * creates are two channels of its own plus their ChannelMember rows, all named
 * with a per-run stamp and all removed in `finally`, children before parents. It
 * never deletes, tombstones or edits a seeded row, and it runs no db:* script.
 *
 * Usage:  BASE=http://localhost:3210 node scripts/smoke-chat-private-visibility.mjs
 */

import { mkdirSync } from "node:fs";
import { psqlScalar as psql } from "./_local-psql.mjs";
import puppeteer from "puppeteer-core";

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
const SMOKE_IP = "10.98.0.4";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = process.env.SHOTS ?? "C:/Users/USER/AppData/Local/Temp/ff-screenshots";
mkdirSync(OUT, { recursive: true });

const PASSWORD = "demo123";
const STAMP = Date.now().toString().slice(-6);

/** The reporter's own seeded account: admin of demo-nimbus. */
const OWNER = { email: "demo@founderflow.app", id: "demo-saqib", name: "Saqib Nawaz" };
/** Added through the UI in phase 2. A plain member — no company role to lean on. */
const INVITEE = { email: "fatima@nimbus.app", id: "demo-fatima", name: "Fatima Sheikh" };
/** Added too, and a COFOUNDER — the residual chat-003 case. */
const COFOUNDER = { email: "ahmed@nimbus.app", id: "demo-ahmed", name: "Ahmed Khan" };
/** Never added to anything. The whole visibility claim rests on this account. */
const OUTSIDER = { email: "sarah@nimbus.app", id: "demo-sarah", name: "Sarah Malik" };

const PRIVATE_NAME = `pvt-smoke-${STAMP}`;
const PUBLIC_NAME = `pub-smoke-${STAMP}`;

let pass = true;
function ok(label) {
  console.log(`  ok    ${label}`);
}
function fail(label, detail) {
  pass = false;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}
function is(label, actual, expected) {
  if (actual === expected) ok(`${label} = ${JSON.stringify(actual)}`);
  else fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function isTrue(label, actual) {
  if (actual) ok(label);
  else fail(label, "was falsy");
}
function isFalse(label, actual) {
  if (!actual) ok(label);
  else fail(label, `was ${JSON.stringify(actual)}`);
}

// Raw SQL against the LOCAL docker Postgres, through the one module allowed to
// shell out to psql. It pins the container as a literal and refuses the run when
// .env.local names a non-loopback host, so this path now carries the same host
// discipline `localDb()` gives the Prisma path — audit harness-004, where six
// smoke scripts (this one among them) reached the database with no host check at
// all. SQL goes in on stdin, so `"User"` needs no shell quoting.

/** Only this run's channels, children before parents. Idempotent. */
function cleanup() {
  try {
    psql(`
      DELETE FROM "Message" WHERE "channelId" IN (
        SELECT id FROM "Channel" WHERE slug LIKE 'pvt-smoke-%' OR slug LIKE 'pub-smoke-%');
      DELETE FROM "ChannelMember" WHERE "channelId" IN (
        SELECT id FROM "Channel" WHERE slug LIKE 'pvt-smoke-%' OR slug LIKE 'pub-smoke-%');
      DELETE FROM "Channel" WHERE slug LIKE 'pvt-smoke-%' OR slug LIKE 'pub-smoke-%';
    `);
  } catch (e) {
    console.error("  cleanup warning:", e.message.split("\n")[0]);
  }
}

async function signIn(page, email) {
  // On a cold dev server the form paints before React hydrates, and a click
  // that lands first performs a native GET submit with no sign-in. Retry until
  // React owns the click. (FaultsAudit A14.)
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle0", timeout: 120000 });
    await page.waitForSelector("input[type=email]", { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.type("input[type=email]", email);
    await page.type("input[type=password]", PASSWORD);
    await page.click("button[type=submit]");
    const left = await page
      .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 60000 })
      .then(() => true)
      .catch(() => false);
    if (left) {
      await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 10000 }).catch(() => {});
      return;
    }
  }
  throw new Error(`could not sign in as ${email}`);
}

/** The rail, exactly as a reader sees it: one <nav> holding every conversation. */
function readRail(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Channels"]');
    if (!nav) return null;
    return {
      text: nav.innerText.replace(/\s+/g, " ").trim(),
      links: Array.from(nav.querySelectorAll("a")).map((a) => ({
        href: a.getAttribute("href"),
        text: a.innerText.replace(/\s+/g, " ").trim(),
        icon: a.querySelector('[role="img"]')?.getAttribute("aria-label") ?? null,
      })),
    };
  });
}

/** The open conversation's own claims about itself. */
function readSurface(page) {
  return page.evaluate(() => {
    // THE CHANNEL header, not the app topbar. `document.querySelector("header")`
    // returns the shell's search bar ("Search expenses, tasks, team... Clock in"),
    // which is how the first run of this script reported "1 member" missing from
    // a header that said 1 member. <ChannelHeader> is the only <header> carrying
    // the conversation's <h1>.
    const header =
      Array.from(document.querySelectorAll("header")).find((h) => h.querySelector("h1")) ?? null;
    return {
      path: location.pathname,
      title: document.title,
      heading: header?.querySelector("h1")?.textContent?.trim() ?? null,
      headerText: header?.innerText.replace(/\s+/g, " ").trim() ?? null,
      hasComposer: !!document.querySelector("textarea"),
      placeholder: document.querySelector("textarea")?.getAttribute("placeholder") ?? null,
      addPeople: Array.from(document.querySelectorAll("button")).some((b) =>
        /add people/i.test(b.innerText)
      ),
      bodyText: document.body.innerText.replace(/\s+/g, " ").trim(),
    };
  });
}

/** Click a <button> by its visible text, anywhere on the page. */
async function clickByText(page, re, scope = "body") {
  const handle = await page.evaluateHandle(
    (pattern, sel) => {
      const rx = new RegExp(pattern, "i");
      const root = document.querySelector(sel) ?? document.body;
      return Array.from(root.querySelectorAll("button")).find((b) => rx.test(b.innerText)) ?? null;
    },
    re.source,
    scope
  );
  const el = handle.asElement();
  if (!el) throw new Error(`no button matching ${re} inside ${scope}`);
  await el.click();
}

cleanup(); // start from a known state

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 950 },
  // --no-proxy-server: headless Chrome on this machine otherwise routes
  // localhost through a corporate proxy and every request times out.
  args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
});

function wire(page, who) {
  page.on("pageerror", (e) => console.error(`PAGEERROR[${who}]:`, e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`CONSOLE.error[${who}]:`, m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 500) console.error(`HTTP ${r.status()} ${r.url()}`);
  });
  return page;
}

let privateSlug = null;
let publicSlug = null;

try {
  /* ══ 1. THE CREATOR MAKES A PRIVATE CHANNEL, THROUGH THE REAL DIALOG ══════ */
  console.log(`\n[1] ${OWNER.email} creates a PRIVATE channel "${PRIVATE_NAME}"`);
  const ownerCtx = await browser.createBrowserContext();
  const owner = wire(await ownerCtx.newPage(), "owner");
  await owner.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
  await signIn(owner, OWNER.email);
  await owner.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 120000 });
  await owner.waitForSelector('nav[aria-label="Channels"]', { timeout: 60000 });

  await owner.click('nav[aria-label="Channels"] button[aria-label="New channel"]');
  await owner.waitForSelector('[role="dialog"]', { timeout: 20000 });
  await owner.type('[role="dialog"] input', PRIVATE_NAME);
  // The kind picker is a radiogroup of two buttons; pick the one that says
  // "Private — Only people you add can see this channel".
  await owner.evaluate(() => {
    const radio = Array.from(document.querySelectorAll('[role="radio"]')).find((r) =>
      /private/i.test(r.innerText)
    );
    if (!radio) throw new Error("no Private radio in the new-channel dialog");
    radio.click();
  });
  // Read aria-checked AFTER React has re-rendered. Reading it inside the same
  // evaluate() reports the PREVIOUS render, and says "false" about a click that
  // worked — a harness bug that looks exactly like a product bug.
  await owner.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('[role="radio"]'))
        .find((r) => /private/i.test(r.innerText))
        ?.getAttribute("aria-checked") === "true",
    { timeout: 10000 }
  );
  ok("the Private option is selected");
  await owner.click('[role="dialog"] button[type="submit"]');
  await owner.waitForFunction(
    (name) => location.pathname.startsWith("/chat/") && !location.pathname.endsWith("/chat"),
    { timeout: 30000 },
    PRIVATE_NAME
  );
  await new Promise((r) => setTimeout(r, 2500));

  const created = await readSurface(owner);
  privateSlug = created.path.replace("/chat/", "");
  console.log(`      landed on ${created.path}  header="${created.headerText}"`);
  await owner.screenshot({ path: `${OUT}/pvt-1-created-by-owner.png` });

  // The database is the fact: the dialog's promise is only kept if the row is
  // actually private and actually holds one member.
  const row = psql(
    `SELECT kind || '|' || (SELECT count(*) FROM "ChannelMember" m WHERE m."channelId" = c.id)
       FROM "Channel" c WHERE c.slug = '${privateSlug}';`
  );
  is("Channel.kind|members in the database", row, "private|1");
  isTrue("the header says 1 member", /1 member/.test(created.headerText ?? ""));
  isTrue(
    "the creator is told nobody else can see it yet",
    /only you can see this private channel/i.test(created.bodyText)
  );
  isTrue("the creator is offered a way to add people", created.addPeople);

  const ownerRail = await readRail(owner);
  const ownerRow = ownerRail?.links.find((l) => l.href === `/chat/${privateSlug}`);
  isTrue("it is in the creator's rail", !!ownerRow);
  is("with a lock, not a hash", ownerRow?.icon ?? null, "Private channel");

  /* ══ 2. ADD TWO TEAMMATES, THROUGH THE REAL DIALOG ════════════════════════ */
  console.log(`\n[2] the creator adds ${INVITEE.name} and ${COFOUNDER.name}`);
  await clickByText(owner, /add people/i);
  await owner.waitForSelector('[role="dialog"] input[type="checkbox"]', { timeout: 20000 });
  const offered = await owner.$$eval('[role="dialog"] label', (ls) =>
    ls.map((l) => l.innerText.replace(/\s+/g, " ").trim())
  );
  console.log(`      dialog offers: ${offered.join(", ")}`);
  isTrue(
    "the picker offers teammates by name",
    offered.includes(INVITEE.name) && offered.includes(COFOUNDER.name)
  );
  isFalse("and never offers the creator themselves", offered.includes(OWNER.name));

  for (const person of [INVITEE, COFOUNDER]) {
    const ticked = await owner.evaluate((name) => {
      const label = Array.from(document.querySelectorAll('[role="dialog"] label')).find((l) =>
        l.innerText.includes(name)
      );
      const box = label?.querySelector('input[type="checkbox"]');
      if (!box) return false;
      box.click();
      return box.checked;
    }, person.name);
    isTrue(`ticked ${person.name}`, ticked);
  }
  await owner.screenshot({ path: `${OUT}/pvt-2-add-people-dialog.png` });
  await clickByText(owner, /^add 2 people$/i, '[role="dialog"]');
  await owner.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 3000));

  const members = psql(
    `SELECT string_agg(u.name || ':' || m.role, ',' ORDER BY u.name)
       FROM "ChannelMember" m JOIN "User" u ON u.id = m."userId"
       JOIN "Channel" c ON c.id = m."channelId" WHERE c.slug = '${privateSlug}';`
  );
  is(
    "the member rows the add wrote",
    members,
    "Ahmed Khan:member,Fatima Sheikh:member,Saqib Nawaz:owner"
  );
  const afterAdd = await readSurface(owner);
  isTrue("the header now says 3 members", /3 members/.test(afterAdd.headerText ?? ""));
  await owner.screenshot({ path: `${OUT}/pvt-2-after-add.png` });

  /* ══ 3. THE ADDED TEAMMATE — DOES SHE SEE IT? ═════════════════════════════ */
  console.log(`\n[3] ${INVITEE.email} (plain member, just added) signs in`);
  const inviteeCtx = await browser.createBrowserContext();
  const invitee = wire(await inviteeCtx.newPage(), "invitee");
  await invitee.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
  await signIn(invitee, INVITEE.email);
  await invitee.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 120000 });
  await invitee.waitForSelector('nav[aria-label="Channels"]', { timeout: 60000 });
  const inviteeRail = await readRail(invitee);
  const inviteeRow = inviteeRail?.links.find((l) => l.href === `/chat/${privateSlug}`);
  console.log(`      her rail: ${inviteeRail?.links.map((l) => l.href).join(", ")}`);
  isTrue("the private channel IS in her rail", !!inviteeRow);
  is("with a lock", inviteeRow?.icon ?? null, "Private channel");

  await invitee.goto(`${BASE}/chat/${privateSlug}`, {
    waitUntil: "networkidle0",
    timeout: 120000,
  });
  await new Promise((r) => setTimeout(r, 2000));
  const inviteeView = await readSurface(invitee);
  await invitee.screenshot({ path: `${OUT}/pvt-3-invitee-sees-it.png` });
  is("she opens it", inviteeView.path, `/chat/${privateSlug}`);
  isTrue("and can post in it", inviteeView.hasComposer);
  isFalse("a plain member is NOT offered the add-people control", inviteeView.addPeople);

  /* ══ 4. THE COFOUNDER — chat-003's RESIDUAL HALF ══════════════════════════ */
  console.log(`\n[4] ${COFOUNDER.email} (cofounder, added as a plain channel member)`);
  const cofoCtx = await browser.createBrowserContext();
  const cofo = wire(await cofoCtx.newPage(), "cofounder");
  await cofo.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
  await signIn(cofo, COFOUNDER.email);
  await cofo.goto(`${BASE}/chat/${privateSlug}`, { waitUntil: "networkidle0", timeout: 120000 });
  await new Promise((r) => setTimeout(r, 2500));
  const cofoView = await readSurface(cofo);
  await cofo.screenshot({ path: `${OUT}/pvt-4-cofounder-can-add.png` });
  is("he opens it", cofoView.path, `/chat/${privateSlug}`);
  const cofoRole = psql(
    `SELECT m.role FROM "ChannelMember" m JOIN "Channel" c ON c.id = m."channelId"
      WHERE c.slug = '${privateSlug}' AND m."userId" = '${COFOUNDER.id}';`
  );
  is("his CHANNEL role is plain member, not owner", cofoRole, "member");
  isTrue(
    "yet he IS offered the add-people control (canManageChannel admits a cofounder)",
    cofoView.addPeople
  );
  // And the control works, not just renders: the server gate is the same
  // predicate, so a control that 403s would be worse than none.
  await clickByText(cofo, /add people/i);
  await cofo.waitForSelector('[role="dialog"] input[type="checkbox"]', { timeout: 20000 });
  const cofoOffered = await cofo.$$eval('[role="dialog"] label', (ls) =>
    ls.map((l) => l.innerText.replace(/\s+/g, " ").trim())
  );
  console.log(`      his dialog offers: ${cofoOffered.join(", ")}`);
  isTrue("and it offers the teammates who are still outside", cofoOffered.includes(OUTSIDER.name));

  /* ══ 5. THE OUTSIDER — THE WHOLE POINT ═══════════════════════════════════ */
  console.log(`\n[5] ${OUTSIDER.email} was never added. What can she see?`);
  const outCtx = await browser.createBrowserContext();
  const out = wire(await outCtx.newPage(), "outsider");
  await out.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
  await signIn(out, OUTSIDER.email);
  await out.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 120000 });
  await out.waitForSelector('nav[aria-label="Channels"]', { timeout: 60000 });
  const outRail = await readRail(out);
  console.log(`      her rail: ${outRail?.links.map((l) => l.href).join(", ")}`);
  console.log(`      her rail text: "${outRail?.text}"`);
  await out.screenshot({ path: `${OUT}/pvt-5-outsider-rail.png` });
  isFalse(
    "the private channel is NOT a link in her rail",
    outRail?.links.some((l) => l.href === `/chat/${privateSlug}`)
  );
  isFalse("its name appears nowhere in her rail", outRail?.text.includes(PRIVATE_NAME));
  const outBody = await out.evaluate(() => document.body.innerText);
  isFalse("nor anywhere else on her chat page", outBody.includes(PRIVATE_NAME));

  // The URL is the other way in, and a guessable one: the slug is the name.
  const direct = await out.goto(`${BASE}/chat/${privateSlug}`, {
    waitUntil: "networkidle0",
    timeout: 120000,
  });
  await new Promise((r) => setTimeout(r, 1500));
  const outDirect = await readSurface(out);
  await out.screenshot({ path: `${OUT}/pvt-5-outsider-direct-url.png` });
  // THE ASSERTION THAT MATTERS IS INDISTINGUISHABILITY, not a particular status
  // code. `getChannelBySlug` returns null both for "you may not see this" and
  // for "there is no such channel", and the page calls notFound() for both, so
  // a private channel must be byte-for-byte as absent as one that was never
  // created. Asserting `=== 404` on its own would have missed a version that
  // 404s the private channel and 200s the nonexistent one — which leaks
  // existence just as loudly as a 403 does.
  const ghostSlug = `pvt-smoke-${STAMP}-no-such-channel`;
  const ghost = await out.goto(`${BASE}/chat/${ghostSlug}`, {
    waitUntil: "networkidle0",
    timeout: 120000,
  });
  await new Promise((r) => setTimeout(r, 1200));
  const ghostView = await readSurface(out);
  console.log(
    `      GET /chat/${privateSlug} -> HTTP ${direct?.status()} | ` +
      `GET /chat/${ghostSlug} (does not exist) -> HTTP ${ghost?.status()}`
  );
  is(
    "a private channel answers exactly like one that does not exist",
    direct?.status(),
    ghost?.status()
  );
  is("and renders the same page", outDirect.bodyText, ghostView.bodyText);
  isTrue("which is the 404 page", /page not found/i.test(outDirect.bodyText));
  isFalse("it does not name the channel", outDirect.bodyText.includes(PRIVATE_NAME));
  isFalse("no composer is rendered for her", outDirect.hasComposer);

  /* ══ 6. chat-006 — WHO THE @-PICKER OFFERS IN A NEW PUBLIC CHANNEL ════════ */
  console.log(`\n[6] ${OWNER.email} creates a PUBLIC channel and types "@"`);
  await owner.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 120000 });
  await owner.waitForSelector('nav[aria-label="Channels"]', { timeout: 60000 });
  await owner.click('nav[aria-label="Channels"] button[aria-label="New channel"]');
  await owner.waitForSelector('[role="dialog"]', { timeout: 20000 });
  await owner.type('[role="dialog"] input', PUBLIC_NAME);
  await owner.click('[role="dialog"] button[type="submit"]');
  await owner.waitForFunction(
    (name) => location.pathname.includes(name.toLowerCase()),
    { timeout: 30000 },
    PUBLIC_NAME
  );
  await new Promise((r) => setTimeout(r, 2500));
  const pub = await readSurface(owner);
  publicSlug = pub.path.replace("/chat/", "");
  const pubRow = psql(
    `SELECT kind || '|' || (SELECT count(*) FROM "ChannelMember" m WHERE m."channelId" = c.id)
       FROM "Channel" c WHERE c.slug = '${publicSlug}';`
  );
  is("a brand-new public channel with one member", pubRow, "public|1");

  await owner.click("textarea");
  await owner.type("textarea", "@");
  await owner.waitForSelector('ul[role="listbox"][aria-label="Mention a teammate"]', {
    timeout: 20000,
  });
  const candidates = await owner.$$eval(
    'ul[role="listbox"][aria-label="Mention a teammate"] li',
    // Each row is [avatar initials, display name, @handle]. Reading index 0
    // reports "SN, AK, AR" — the Avatar's initials — so no assertion about a
    // person's name can ever match, whatever the product does.
    (lis) =>
      lis.map((li) =>
        li.innerText
          .split("\n")
          .map((t) => t.trim())
          .filter((t) => t && !t.startsWith("@"))
          .pop()
      )
  );
  console.log(`      the @-picker offers: ${candidates.join(", ")}`);
  await owner.screenshot({ path: `${OUT}/pvt-6-mention-roster-public.png` });
  isTrue(
    "it offers a teammate who is NOT a ChannelMember of this channel",
    candidates.includes(OUTSIDER.name)
  );
  isTrue(
    "in fact it offers the whole live workspace",
    [INVITEE.name, COFOUNDER.name, OUTSIDER.name, "Ali Raza"].every((n) => candidates.includes(n))
  );

  console.log(`\n[7] the same picker in the PRIVATE channel stays members-only`);
  await owner.goto(`${BASE}/chat/${privateSlug}`, { waitUntil: "networkidle0", timeout: 120000 });
  await new Promise((r) => setTimeout(r, 2000));
  await owner.click("textarea");
  await owner.type("textarea", "@");
  await owner.waitForSelector('ul[role="listbox"][aria-label="Mention a teammate"]', {
    timeout: 20000,
  });
  const privateCandidates = await owner.$$eval(
    'ul[role="listbox"][aria-label="Mention a teammate"] li',
    // Each row is [avatar initials, display name, @handle]. Reading index 0
    // reports "SN, AK, AR" — the Avatar's initials — so no assertion about a
    // person's name can ever match, whatever the product does.
    (lis) =>
      lis.map((li) =>
        li.innerText
          .split("\n")
          .map((t) => t.trim())
          .filter((t) => t && !t.startsWith("@"))
          .pop()
      )
  );
  console.log(`      the @-picker offers: ${privateCandidates.join(", ")}`);
  await owner.screenshot({ path: `${OUT}/pvt-7-mention-roster-private.png` });
  isFalse(
    "a teammate outside the private channel is NOT offered",
    privateCandidates.includes(OUTSIDER.name)
  );
  isTrue(
    "its three members are",
    [OWNER.name, INVITEE.name, COFOUNDER.name].every((n) => privateCandidates.includes(n))
  );
} catch (e) {
  fail("threw", e.message);
  console.error(e.stack);
} finally {
  await browser.close();
  cleanup();
  const left = psql(
    `SELECT count(*) FROM "Channel" WHERE slug LIKE 'pvt-smoke-%' OR slug LIKE 'pub-smoke-%';`
  );
  console.log(`\ncleanup: ${left} smoke channels left behind (want 0)`);
  console.log(`screenshots: ${OUT}`);
  console.log(pass ? "\nSMOKE PASS" : "\nSMOKE FAIL");
  process.exit(pass && left === "0" ? 0 : 1);
}
