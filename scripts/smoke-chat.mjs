/*
 * Chat smoke test.
 *
 * Asserts the things the user actually cares about:
 *  - /chat lands in a channel and the migration's #general is there
 *  - a message sends with ENTER (not the button) and renders
 *  - a reaction toggles on and off, and reports itself pressed
 *  - a MEMBER can reach /chat (chat is deliberately not role-gated) while
 *    /dashboard still bounces them
 *  - a private channel is invisible AND unreachable for a non-member, and
 *    answers not-found rather than 403 (a 403 confirms it exists)
 *  - the database agrees with the UI: the message landed, and the reader's
 *    read watermark actually advanced
 *
 * Seed assumptions: company demo-nimbus. demo@founderflow.app is admin,
 * fatima@nimbus.app is a plain member. Everything it creates is removed in
 * `finally`, including on failure -- and, since audit harness-011, every row it
 * UPDATED is put back too. Reading a channel advances a SEEDED
 * ChannelMember.lastReadAt, which is not an insert and was therefore invisible
 * to the old cleanup.
 */

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
const SMOKE_IP = "10.98.0.5";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";
const STAMP = Date.now().toString().slice(-6);

// Pinned to the local docker Postgres. `new PrismaClient()` would read the
// root .env, which points at production — see scripts/_local-db.mjs.
const db = localDb();

function ok(label) {
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

async function signIn(page, email, password) {
  // On a cold dev server the form paints before React hydrates; a click that
  // lands first performs a NATIVE submit, which (the form declares no method)
  // becomes a GET with the credentials in the query string and no sign-in.
  // Retry until React owns the click. Tracked as FaultsAudit A14.
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

function wire(page) {
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE.error:", m.text());
  });
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });
  console.log("== chat smoke ==");

  const body = `chat smoke ${STAMP}`;
  let privateChannelId = null;

  /**
   * READ WATERMARKS, SNAPSHOTTED BEFORE ANYTHING OPENS A CHANNEL
   * (audit harness-011).
   *
   * This script's cleanup covered everything it INSERTED and nothing it
   * UPDATED. Opening #general calls markChannelRead, which advances
   * ChannelMember.lastReadAt on a SEEDED row -- so every run left the demo
   * workspace a little different from the seed, and scripts/_qa-guard.mjs
   * (which hashes whole channelMember rows) reported
   * "channelMember: same N rows but CONTENT CHANGED (an update)" against every
   * other agent's cleanup verification.
   *
   * Restoring by ID is what makes this safe to run after the deletes below: the
   * private channel's member rows are created during the run, so they are not in
   * this snapshot and cannot be resurrected by it.
   */
  const watermarksBefore = await db.channelMember.findMany({
    where: { channel: { companyId: "demo-nimbus" } },
    select: { id: true, lastReadAt: true },
  });
  console.log(`  (snapshotted ${watermarksBefore.length} read watermarks)`);

  try {
    // ── admin ───────────────────────────────────────────────────────
    const adminCtx = await browser.createBrowserContext();
    const admin = await adminCtx.newPage();
    await admin.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
    wire(admin);
    await signIn(admin, "demo@founderflow.app", "demo123");

    await admin.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
    const landed = new URL(admin.url()).pathname;
    if (landed.startsWith("/chat/")) ok(`landed in a channel (${landed})`);
    else fail("chat landing", `expected /chat/<slug>, got ${landed}`);

    await admin.waitForSelector('nav[aria-label="Channels"]', { timeout: 20000 });
    const railNames = await admin.evaluate(() =>
      [...document.querySelectorAll('nav[aria-label="Channels"] a')].map((a) =>
        a.textContent.trim()
      )
    );
    if (railNames.some((n) => n.toLowerCase().includes("general"))) {
      ok("#general from the migration backfill is in the rail");
    } else {
      fail("general channel", JSON.stringify(railNames));
    }

    // ── send with Enter, not the button ─────────────────────────────
    const composer = await admin.$('[role="log"] ~ * textarea, textarea');
    if (!composer) {
      fail("composer", "no textarea found on the chat page");
    } else {
      await composer.click();
      await admin.keyboard.type(body);
      await admin.keyboard.press("Enter");
      const appeared = await admin
        .waitForFunction((t) => document.body.innerText.includes(t), { timeout: 15000 }, body)
        .then(() => true)
        .catch(() => false);
      if (appeared) ok("message sent with Enter and rendered");
      else fail("send with Enter", "message never appeared");
    }

    await admin.screenshot({ path: `${OUT}/chat-01-channel.png` });

    // ── reactions toggle ────────────────────────────────────────────
    const reactionResult = await admin.evaluate(() => {
      const btns = [...document.querySelectorAll("button[aria-pressed]")];
      return { found: btns.length };
    });
    if (reactionResult.found > 0) {
      const before = await admin.evaluate(() =>
        document.querySelector("button[aria-pressed]").getAttribute("aria-pressed")
      );
      await admin.click("button[aria-pressed]");
      await new Promise((r) => setTimeout(r, 1200));
      const after = await admin.evaluate(() =>
        document.querySelector("button[aria-pressed]").getAttribute("aria-pressed")
      );
      if (before !== after) ok(`reaction toggles (${before} -> ${after})`);
      else fail("reaction toggle", `aria-pressed stayed ${before}`);
    } else {
      console.log("  ..  no reaction control on screen; skipping the toggle check");
    }

    // ── a private channel the member is not in ──────────────────────
    const generalChannel = await db.channel.findFirst({ where: { slug: "general" } });
    const privateSlug = `smoke-private-${STAMP}`;
    const created = await db.channel.create({
      data: {
        companyId: generalChannel.companyId,
        kind: "private",
        slug: privateSlug,
        name: `Smoke private ${STAMP}`,
        createdBy: generalChannel.createdBy,
        members: { create: { userId: generalChannel.createdBy, role: "owner" } },
      },
    });
    privateChannelId = created.id;

    await admin.close();
    await adminCtx.close();

    // ── member ──────────────────────────────────────────────────────
    const memberCtx = await browser.createBrowserContext();
    const member = await memberCtx.newPage();
    await member.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
    wire(member);
    await signIn(member, "fatima@nimbus.app", "demo123");

    await member.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
    const memberPath = new URL(member.url()).pathname;
    if (memberPath.startsWith("/chat")) {
      ok("a member reaches /chat — chat is deliberately not role-gated");
    } else {
      fail("member chat access", `redirected to ${memberPath}`);
    }

    await member.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 });
    const bounced = new URL(member.url()).pathname;
    if (bounced !== "/dashboard") ok(`a member is still blocked from /dashboard (-> ${bounced})`);
    else fail("member finance gate", "reached /dashboard");

    // The highest-value assertion here: invisible AND unreachable, and the
    // response must not distinguish "no permission" from "does not exist".
    await member.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
    const memberRail = await member.evaluate(() =>
      [...document.querySelectorAll('nav[aria-label="Channels"] a')].map((a) =>
        a.textContent.trim()
      )
    );
    if (!memberRail.some((n) => n.includes(STAMP))) {
      ok("the private channel is absent from a non-member's rail");
    } else {
      fail("private channel leak", JSON.stringify(memberRail));
    }

    const res = await member.goto(`${BASE}/chat/${privateSlug}`, {
      waitUntil: "networkidle0",
      timeout: 60000,
    });
    const status = res ? res.status() : 0;
    const notFound = await member.evaluate(() => /not found|404/i.test(document.body.innerText));
    if (status === 404 || notFound) {
      ok("a non-member gets not-found for a private channel, not a 403");
    } else {
      fail("private channel direct URL", `status ${status}, body did not read as not-found`);
    }
    await member.screenshot({ path: `${OUT}/chat-02-member-private.png` });

    // ── the database agrees with the UI ─────────────────────────────
    const stored = await db.message.count({ where: { body } });
    if (stored === 1) ok("the message is in the database");
    else fail("message persisted", `expected 1 row for "${body}", found ${stored}`);

    const msg = await db.message.findFirst({ where: { body } });
    if (msg) {
      const watermark = await db.channelMember.findFirst({
        where: { channelId: msg.channelId, userId: msg.authorId },
        select: { lastReadAt: true },
      });
      if (watermark && watermark.lastReadAt >= msg.createdAt) {
        ok("the sender's read watermark advanced past their own message");
      } else {
        fail("read watermark", `lastReadAt=${watermark?.lastReadAt} vs message=${msg.createdAt}`);
      }
    }
  } finally {
    // Belt-and-braces: restore the seed even if something threw.
    try {
      const msgs = await db.message.findMany({ where: { body }, select: { id: true } });
      await db.messageReaction.deleteMany({ where: { messageId: { in: msgs.map((m) => m.id) } } });
      await db.message.deleteMany({ where: { body } });
      if (privateChannelId) {
        await db.channelMember.deleteMany({ where: { channelId: privateChannelId } });
        await db.message.deleteMany({ where: { channelId: privateChannelId } });
        await db.channel.delete({ where: { id: privateChannelId } });
      }
      // ...and the rows this run UPDATED rather than inserted. `updateMany` on the
      // id keeps a row deleted above from being recreated, which `update` would
      // throw on and `upsert` would do.
      let restored = 0;
      for (const row of watermarksBefore) {
        const res = await db.channelMember.updateMany({
          where: { id: row.id, lastReadAt: { not: row.lastReadAt } },
          data: { lastReadAt: row.lastReadAt },
        });
        restored += res.count;
      }
      if (restored > 0) console.log(`  (restored ${restored} read watermark(s))`);
    } catch (e) {
      console.error("cleanup failed:", e.message);
    }
    await browser.close();
    await db.$disconnect();
  }

  console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
}

main().catch((err) => {
  console.error("smoke threw:", err);
  process.exit(1);
});
