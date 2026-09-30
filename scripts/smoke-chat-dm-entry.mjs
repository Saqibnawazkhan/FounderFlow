/*
 * Chat: THE WAY IN TO A DIRECT MESSAGE, AND WHAT A DM LOOKS LIKE ONCE IT IS OPEN.
 *
 * Reported from the running product, with a screenshot: "theres no option for
 * dm in chat". smoke-chat-dm.mjs already covers that openDmAction works, that
 * it is idempotent and that a third party cannot see the conversation. This
 * script covers the two things it does NOT, both of which a user experiences
 * and no unit test can see:
 *
 *   1. DISCOVERABILITY. A reader with no DMs yet had a Direct section made of a
 *      9px mono label and a 12px icon-only "+", and in a workspace of one the
 *      section did not render at all — `onNewDm` was withheld. So there was no
 *      wording anywhere in the product that said you could message a person.
 *      Asserted here by ACCESSIBLE NAME, in a browser, against the rail a signed
 *      -in user actually gets.
 *
 *   2. chat-008 — A DM RENDERED AS A CHANNEL. Three surfaces addressed a
 *      colleague as a room: the browser tab ("#Ahmed Khan · FounderFlow"), the
 *      composer ("Message #Ahmed Khan") and the channel header (a Hash glyph,
 *      because the icon was picked with `isPrivate ? Lock : Hash`). In this
 *      product a hash means "a room", and a room means other people can be in
 *      it, so the glyph misrepresented who could read the conversation.
 *
 *   3. A COUNTERPART WHO LEFT. Tier 3 tombstones users and leaves their
 *      ChannelMember rows alone, so a DM with a deactivated colleague read
 *      exactly like a live one. It must degrade honestly, and it must not go
 *      blank — the history stays readable by design.
 *
 * WHAT THIS TOUCHES. It signs in as the SEEDED ali@nimbus.app (who begins with
 * no DMs, which is the state the bug is about) and creates a DM with
 * fatima@nimbus.app plus ONE throwaway user of its own. Everything it creates
 * is removed in `finally`, children before parents. It never deletes or
 * tombstones a seeded row, and it never runs a db:* script.
 *
 * Usage:  BASE=http://localhost:3100 node scripts/smoke-chat-dm-entry.mjs
 */

import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = process.env.SHOTS ?? "C:/Users/USER/AppData/Local/Temp/ff-screenshots";
mkdirSync(OUT, { recursive: true });

const PASSWORD = "demo123";
/**
 * The account the bug was reported from, and the DM it already had. Phase 0
 * reads it and changes nothing: it is the one assertion in this file made
 * against the exact row and the exact user in the screenshot.
 */
const OWNER = { email: "demo@founderflow.app", id: "demo-saqib" };
const OWNER_DM = { slug: "dm-demo-ahmed_demo-saqib", counterpart: "Ahmed Khan" };
const SENDER = { email: "ali@nimbus.app", id: "demo-ali", name: "Ali Raza" };
const TARGET = { email: "fatima@nimbus.app", id: "demo-fatima", name: "Fatima Sheikh" };
const STAMP = Date.now().toString().slice(-6);
/**
 * A throwaway workspace of ONE, for the exact state that was reported.
 *
 * Built in SQL rather than driven through /signup on purpose. The signup wizard
 * is two steps with its own validation and is owned by another slice; a smoke
 * test for the CHAT rail should not fail because a field moved on a marketing
 * form. What this scenario needs is precisely "a live admin whose workspace has
 * one member and one channel", and that is four INSERTs. The password hash is
 * COPIED from a seeded user (a read, never a write to them), so the throwaway
 * signs in with the same demo123 as everyone else.
 */
const SOLO = {
  companyId: `dmsmoke-solo-co-${STAMP}`,
  userId: `dmsmoke-solo-${STAMP}`,
  channelId: `dmsmoke-solo-ch-${STAMP}`,
  email: `dmsmoke-solo-${STAMP}@nimbus.test`,
  name: "Solo Founder",
  company: `DmSmoke Solo ${STAMP}`,
};
/** The one row this script creates, so the deactivated case needs no seeded victim. */
const GHOST = {
  id: `dmsmoke-ghost-${Date.now().toString().slice(-6)}`,
  name: "Nadia Ghost",
  email: `dmsmoke-ghost-${Date.now().toString().slice(-6)}@nimbus.test`,
};

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

/**
 * Raw SQL against the LOCAL docker Postgres only. Deliberately not a Prisma
 * client: a bare `new PrismaClient()` resolves the root .env, and scripts/ is
 * held to `localDb()` for exactly that reason (CLAUDE.md, Tier 2).
 */
function psql(sql) {
  return execSync("docker exec -i founderflow-postgres psql -U founderflow -d founderflow -tA", {
    input: sql,
    encoding: "utf8",
  }).trim();
}

/** Every row this run created, removed children-before-parents. Idempotent. */
function cleanup() {
  try {
    psql(`
      DELETE FROM "Notification" WHERE "userId" IN ('${GHOST.id}')
        OR link LIKE '/chat/dm-%${GHOST.id}%';
      DELETE FROM "Message" WHERE "channelId" IN (
        SELECT id FROM "Channel" WHERE "dmKey" LIKE '%${GHOST.id}%'
           OR "dmKey" = '${[SENDER.id, TARGET.id].sort().join(":")}');
      DELETE FROM "ChannelMember" WHERE "channelId" IN (
        SELECT id FROM "Channel" WHERE "dmKey" LIKE '%${GHOST.id}%'
           OR "dmKey" = '${[SENDER.id, TARGET.id].sort().join(":")}');
      DELETE FROM "Channel" WHERE "dmKey" LIKE '%${GHOST.id}%'
         OR "dmKey" = '${[SENDER.id, TARGET.id].sort().join(":")}';
      DELETE FROM "User" WHERE id = '${GHOST.id}' OR email LIKE 'dmsmoke-ghost-%@nimbus.test';
    `);
    // The throwaway signup workspace. Chat rows first (Channel -> Company is
    // Cascade, but Message and ChannelMember go explicitly so the order stays
    // children-before-parents whatever the FK graph does later), then Activity,
    // then the Company — whose delete cascades its one User.
    psql(`
      DELETE FROM "Message" WHERE "companyId" IN (
        SELECT id FROM "Company" WHERE name LIKE 'DmSmoke Solo %');
      DELETE FROM "ChannelMember" WHERE "channelId" IN (
        SELECT id FROM "Channel" WHERE "companyId" IN (
          SELECT id FROM "Company" WHERE name LIKE 'DmSmoke Solo %'));
      DELETE FROM "Channel" WHERE "companyId" IN (
        SELECT id FROM "Company" WHERE name LIKE 'DmSmoke Solo %');
      DELETE FROM "Activity" WHERE "companyId" IN (
        SELECT id FROM "Company" WHERE name LIKE 'DmSmoke Solo %');
      DELETE FROM "User" WHERE email LIKE 'dmsmoke-solo-%@nimbus.test';
      DELETE FROM "Company" WHERE name LIKE 'DmSmoke Solo %';
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
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
    await page.waitForSelector("input[type=email]", { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 1200));
    await page.type("input[type=email]", email);
    await page.type("input[type=password]", PASSWORD);
    await page.click("button[type=submit]");
    const left = await page
      .waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 60000 })
      .then(() => true)
      .catch(() => false);
    if (left) {
      await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 8000 }).catch(() => {});
      return;
    }
  }
  throw new Error(`could not sign in as ${email}`);
}

/** What the open conversation says about itself, read from the live DOM. */
function readSurface(page) {
  return page.evaluate(() => {
    const header = document.querySelector("main header, header:has(h1)") ?? null;
    const h1 = document.querySelector("h1");
    const box = document.querySelector("textarea");
    return {
      path: location.pathname,
      title: document.title,
      heading: h1?.textContent?.trim() ?? null,
      placeholder: box?.getAttribute("placeholder") ?? null,
      // The sr-only <label> is the only wording a screen-reader user hears.
      srLabel: box?.id
        ? (document.querySelector(`label[for="${box.id}"]`)?.textContent?.trim() ?? null)
        : null,
      headerText: header?.innerText?.trim() ?? null,
      // The Avatar is the only element in the header carrying title={name}, so
      // its presence is exactly "a portrait was drawn, not a channel glyph".
      headerAvatarTitle:
        header?.querySelector("[title]")?.getAttribute("title") ??
        h1?.parentElement?.querySelector("[title]")?.getAttribute("title") ??
        null,
      bodyText: document.body.innerText,
    };
  });
}

function readRail(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Channels"]');
    if (!nav) return null;
    return {
      text: nav.innerText,
      links: Array.from(nav.querySelectorAll("a")).map((a) => ({
        href: a.getAttribute("href"),
        text: a.innerText.replace(/\s+/g, " ").trim(),
      })),
      buttons: Array.from(nav.querySelectorAll("button")).map(
        (b) => b.getAttribute("aria-label") || b.innerText.replace(/\s+/g, " ").trim()
      ),
    };
  });
}

cleanup(); // start from a known state

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1440, height: 900 },
  // --no-proxy-server: headless Chrome on this machine otherwise routes
  // localhost through a corporate proxy and every request times out.
  args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.error("CONSOLE.error:", m.text());
});
page.on("response", (r) => {
  if (r.status() >= 500) console.error(`HTTP ${r.status()} ${r.url()}`);
});

try {
  /* ── 0. THE REPORTED ACCOUNT, THE REPORTED CONVERSATION ─────────────────── */
  // Read-only, and skipped rather than failed if the row is not there: this
  // asserts against a DM the product owner opened by hand on 2026-09-25, not
  // against seed data, so a reseeded database must not turn it into a red run.
  const ownerDmExists =
    psql(`SELECT count(*) FROM "Channel" WHERE slug = '${OWNER_DM.slug}';`) === "1";
  if (!ownerDmExists) {
    console.log(`
[0] skipped — ${OWNER_DM.slug} is not in this database`);
  } else {
    console.log(`
[0] ${OWNER.email} opens the DM they already had`);
    await signIn(page, OWNER.email);
    await page.goto(`${BASE}/chat/${OWNER_DM.slug}`, {
      waitUntil: "networkidle0",
      timeout: 90000,
    });
    await new Promise((r) => setTimeout(r, 2500));
    const owner = await readSurface(page);
    await page.screenshot({ path: `${OUT}/dm-entry-0-reported-account.png` });
    console.log(`      title="${owner.title}"  placeholder="${owner.placeholder}"`);
    is("their tab title", owner.title, `${OWNER_DM.counterpart} · FounderFlow`);
    is("their composer placeholder", owner.placeholder, `Message ${OWNER_DM.counterpart}`);
    is("their header avatar", owner.headerAvatarTitle, OWNER_DM.counterpart);
    const ownerRail = await readRail(page);
    const ownerRow = ownerRail?.links.find((l) => l.href === `/chat/${OWNER_DM.slug}`);
    if (ownerRow && ownerRow.text.includes(OWNER_DM.counterpart)) {
      ok(`their rail lists it as "${ownerRow.text}"`);
    } else {
      fail("their rail lists the DM by the person's name", JSON.stringify(ownerRail?.links));
    }
    // Sign out so phase 1 starts from a clean session.
    await page.goto(`${BASE}/api/auth/signout`, { waitUntil: "networkidle0" }).catch(() => {});
    await page.deleteCookie(...(await page.cookies()));
  }

  /* ── 1. A reader with no DMs is TOLD they can message a person ───────────── */
  console.log(`\n[1] ${SENDER.email} signs in with no DMs at all`);
  await signIn(page, SENDER.email);
  await page.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 90000 });
  await new Promise((r) => setTimeout(r, 2000));

  let rail = await readRail(page);
  if (!rail) throw new Error("no channel rail rendered");
  console.log(`      rail buttons: ${JSON.stringify(rail.buttons)}`);
  await page.screenshot({ path: `${OUT}/dm-entry-1-rail-empty.png` });

  if (rail.text.includes("DIRECT") || rail.text.includes("Direct")) {
    ok("the rail has a Direct section even with no DMs in it");
  } else {
    fail("the rail has a Direct section even with no DMs in it", rail.text.replace(/\n/g, " | "));
  }
  if (rail.buttons.some((b) => /message a teammate/i.test(b))) {
    ok('a control named "Message a teammate" exists (words, not a 12px glyph)');
  } else {
    fail('a control named "Message a teammate" exists', JSON.stringify(rail.buttons));
  }

  /* ── 2. Pressing it opens the picker and lands in the DM ─────────────────── */
  console.log(`\n[2] start a DM with ${TARGET.name}`);
  await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Channels"]');
    const btn = Array.from(nav.querySelectorAll("button")).find((b) =>
      /message a teammate/i.test(b.innerText)
    );
    if (!btn) throw new Error("no labelled DM control to click");
    btn.click();
  });
  await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
  await page.screenshot({ path: `${OUT}/dm-entry-2-picker.png` });
  ok("the picker opened");

  const picked = await page.evaluate((name) => {
    const dialog = document.querySelector('[role="dialog"]');
    const row = Array.from(dialog.querySelectorAll("button")).find((b) =>
      b.innerText.includes(name)
    );
    if (!row) return null;
    row.click();
    return row.innerText.replace(/\s+/g, " ").trim();
  }, TARGET.name);
  if (picked) ok(`picked "${picked}"`);
  else fail(`the picker offered ${TARGET.name}`);

  const dmSlug = `dm-${[SENDER.id, TARGET.id].sort().join("_")}`;
  const arrived = await page
    .waitForFunction((slug) => location.pathname === `/chat/${slug}`, { timeout: 30000 }, dmSlug)
    .then(() => true)
    .catch(() => false);
  await new Promise((r) => setTimeout(r, 2500));
  if (arrived) ok(`landed on /chat/${dmSlug}`);
  else
    fail(`landed on /chat/${dmSlug}`, `still at ${await page.evaluate(() => location.pathname)}`);

  const dbRows = psql(
    `SELECT count(*) FROM "Channel" WHERE "dmKey" = '${[SENDER.id, TARGET.id].sort().join(":")}';`
  );
  is("DM rows in the database for the pair", dbRows, "1");

  /* ── 3. chat-008: the open DM is a PERSON, not a room ────────────────────── */
  console.log(`\n[3] chat-008 — what the open DM calls itself`);
  let surface = await readSurface(page);
  console.log(`      title="${surface.title}"  placeholder="${surface.placeholder}"`);
  await page.screenshot({ path: `${OUT}/dm-entry-3-open-dm.png` });

  is("browser tab title", surface.title, `${TARGET.name} · FounderFlow`);
  is("heading", surface.heading, TARGET.name);
  is("composer placeholder", surface.placeholder, `Message ${TARGET.name}`);
  is("composer sr-only label", surface.srLabel, `Message ${TARGET.name}`);
  is("header avatar is the counterpart", surface.headerAvatarTitle, TARGET.name);
  if (surface.headerText && /direct message/i.test(surface.headerText)) {
    ok('the header says "Direct message" instead of counting to two');
  } else {
    fail('the header says "Direct message"', JSON.stringify(surface.headerText));
  }
  if (surface.headerText && /\d+ members?/.test(surface.headerText)) {
    fail("the header does NOT count members in a DM", surface.headerText);
  } else {
    ok("the header does not count members in a DM");
  }
  if (surface.title.includes("#")) fail("no hash anywhere in the tab title", surface.title);
  else ok("no hash in the tab title");

  /* ── 4. Send a message; reload; it is still there and still a person ─────── */
  console.log(`\n[4] send, reload, and check it survived`);
  const BODY = `dm entry smoke ${Date.now().toString().slice(-6)}`;
  await page.click("textarea");
  await page.type("textarea", BODY);
  await page.keyboard.down("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
  await new Promise((r) => setTimeout(r, 3500));

  await page.reload({ waitUntil: "networkidle0", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  surface = await readSurface(page);
  await page.screenshot({ path: `${OUT}/dm-entry-4-after-reload.png` });

  if (surface.bodyText.includes(BODY)) ok("the message is still on screen after a reload");
  else fail("the message survived a reload", `"${BODY}" not in the page`);
  is("tab title after reload", surface.title, `${TARGET.name} · FounderFlow`);
  is("placeholder after reload", surface.placeholder, `Message ${TARGET.name}`);

  const stored = psql(
    `SELECT count(*) FROM "Message" m JOIN "Channel" c ON c.id = m."channelId"
     WHERE c."dmKey" = '${[SENDER.id, TARGET.id].sort().join(":")}' AND m.body = '${BODY}';`
  );
  is("the message is in the database", stored, "1");

  rail = await readRail(page);
  const dmLink = rail.links.find((l) => l.href === `/chat/${dmSlug}`);
  if (dmLink && dmLink.text.includes(TARGET.name)) {
    ok(`the rail now lists the DM as "${dmLink.text}"`);
  } else {
    fail("the rail lists the DM by the person's name", JSON.stringify(rail.links));
  }
  if (rail.buttons.some((b) => /message a teammate/i.test(b))) {
    fail(
      "the labelled control is withdrawn once the section has rows",
      JSON.stringify(rail.buttons)
    );
  } else {
    ok("the labelled control is withdrawn once the section has rows");
  }

  /* ── 5. A counterpart who has left the workspace ─────────────────────────── */
  console.log(`\n[5] a DM with a DEACTIVATED teammate degrades honestly`);
  // A throwaway user of this script's own making, so no seeded row is touched.
  psql(`
    INSERT INTO "User" (id, name, email, "passwordHash", role, "companyId")
    VALUES ('${GHOST.id}', '${GHOST.name}', '${GHOST.email}',
            '$2b$12$notarealhashnotarealhashnotarealhashnotarealhashnotar',
            'member', 'demo-nimbus');
  `);
  const ghostKey = [SENDER.id, GHOST.id].sort().join(":");
  const ghostSlug = `dm-${[SENDER.id, GHOST.id].sort().join("_")}`;

  await page.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2000));
  await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Channels"]');
    const btn = Array.from(nav.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "New direct message"
    );
    if (!btn) throw new Error("no New direct message control");
    btn.click();
  });
  await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
  await page.evaluate((name) => {
    const dialog = document.querySelector('[role="dialog"]');
    const row = Array.from(dialog.querySelectorAll("button")).find((b) =>
      b.innerText.includes(name)
    );
    if (!row) throw new Error("throwaway teammate not in the picker");
    row.click();
  }, GHOST.name);
  await page
    .waitForFunction((slug) => location.pathname === `/chat/${slug}`, { timeout: 30000 }, ghostSlug)
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  surface = await readSurface(page);
  is("a live throwaway teammate reads plainly", surface.heading, GHOST.name);

  // Now deactivate them, exactly as deleteAccountAction would.
  psql(`UPDATE "User" SET "deletedAt" = now() WHERE id = '${GHOST.id}';`);
  await page.reload({ waitUntil: "networkidle0", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  surface = await readSurface(page);
  rail = await readRail(page);
  await page.screenshot({ path: `${OUT}/dm-entry-5-deactivated.png` });

  is("the header says they have gone", surface.heading, `${GHOST.name} (deactivated)`);
  if (surface.heading && surface.heading.trim().length > 0) {
    ok("the conversation did not go blank");
  } else {
    fail("the conversation did not go blank", JSON.stringify(surface.heading));
  }
  const ghostRow = rail.links.find((l) => l.href === `/chat/${ghostSlug}`);
  if (ghostRow && /deactivated/i.test(ghostRow.text)) {
    ok(`the rail says so too: "${ghostRow.text}"`);
  } else {
    fail("the rail marks a deactivated counterpart", JSON.stringify(ghostRow ?? rail.links));
  }
  // And they are no longer offered as someone new to start talking to.
  const stillOffered = await page.evaluate(async (name) => {
    const nav = document.querySelector('nav[aria-label="Channels"]');
    const btn = Array.from(nav.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "New direct message"
    );
    btn.click();
    await new Promise((r) => setTimeout(r, 600));
    const dialog = document.querySelector('[role="dialog"]');
    return dialog ? dialog.innerText.includes(name) : null;
  }, GHOST.name);
  if (stillOffered === false) ok("a deactivated teammate is no longer in the DM picker");
  else fail("a deactivated teammate is out of the picker", `saw ${stillOffered}`);

  console.log(`\n  (dmKey created for the throwaway: ${ghostKey})`);

  /* ── 6. A WORKSPACE OF ONE — the exact state that was reported ───────────── */
  // This is the branch a brand-new workspace is always in, and the one where
  // the Direct section used to disappear completely: `onNewDm` was withheld
  // when the roster was empty, so the reader most in need of being told that
  // DMs exist was the one reader guaranteed not to be told.
  console.log(`\n[6] a brand-new workspace of one still offers a way to message a person`);
  // A SEPARATE browser context, not just a new tab: the middleware bounces a
  // signed-in visitor off /signup, so reusing Ali's cookie jar lands on
  // /dashboard and the form is never there to fill.
  psql(`
    INSERT INTO "Company" (id, name, industry)
      VALUES ('${SOLO.companyId}', '${SOLO.company}', 'Software');
    INSERT INTO "User" (id, name, email, "passwordHash", role, "companyId")
      SELECT '${SOLO.userId}', '${SOLO.name}', '${SOLO.email}', u."passwordHash",
             'admin', '${SOLO.companyId}'
        FROM "User" u WHERE u.email = '${SENDER.email}';
    INSERT INTO "Channel" (id, "companyId", kind, slug, name, "createdBy")
      VALUES ('${SOLO.channelId}', '${SOLO.companyId}', 'public', 'general', 'general',
              '${SOLO.userId}');
    INSERT INTO "ChannelMember" (id, "channelId", "userId", role)
      VALUES ('${SOLO.channelId}-m', '${SOLO.channelId}', '${SOLO.userId}', 'owner');
  `);

  // A SEPARATE browser context, not just a new tab: reusing Ali's cookie jar
  // would keep his session and never exercise the solo workspace at all.
  const soloCtx = await browser.createBrowserContext();
  const solo = await soloCtx.newPage();
  solo.on("pageerror", (e) => console.error("PAGEERROR(solo):", e.message));
  try {
    await signIn(solo, SOLO.email);
    await solo.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2500));
    const soloRail = await readRail(solo);
    await solo.screenshot({ path: `${OUT}/dm-entry-6-workspace-of-one.png` });
    if (!soloRail) {
      fail("the solo workspace rendered a rail", `at ${solo.url()}`);
    } else {
      console.log(`      solo rail text: ${JSON.stringify(soloRail.text)}`);
      console.log(`      solo rail buttons: ${JSON.stringify(soloRail.buttons)}`);
      if (soloRail.buttons.some((b) => /message a teammate/i.test(b))) {
        ok("a workspace of one is STILL offered a way to message a person");
      } else {
        fail("a workspace of one is offered a way to message a person", JSON.stringify(soloRail));
      }
      // And pressing it explains itself rather than being a dead end — the
      // <NewDmModal> empty state that was unreachable until this fix, because
      // the only two callers both withheld the trigger in exactly this case.
      const explained = await solo.evaluate(async () => {
        const nav = document.querySelector('nav[aria-label="Channels"]');
        const btn = Array.from(nav.querySelectorAll("button")).find((b) =>
          /message a teammate/i.test(b.innerText)
        );
        if (!btn) return null;
        btn.click();
        await new Promise((r) => setTimeout(r, 900));
        return document.querySelector('[role="dialog"]')?.innerText ?? null;
      });
      await solo.screenshot({ path: `${OUT}/dm-entry-6-picker-explains.png` });
      if (explained && /only person in this workspace/i.test(explained)) {
        ok("the picker explains why it cannot help yet, and names the Team page");
      } else {
        fail("the picker explains the empty roster", JSON.stringify(explained));
      }
    }
  } finally {
    await solo.close();
    await soloCtx.close();
  }
} catch (e) {
  pass = false;
  console.error("\nTHREW:", e.message);
  try {
    await page.screenshot({ path: `${OUT}/dm-entry-THREW.png` });
  } catch {
    /* the page may be gone */
  }
} finally {
  await browser.close();
  cleanup();
  const left = psql(
    `SELECT (SELECT count(*) FROM "User" WHERE email LIKE 'dmsmoke-%@nimbus.test')::text
       || '/' || (SELECT count(*) FROM "Channel" WHERE "dmKey" LIKE '%dmsmoke-ghost%')::text
       || '/' || (SELECT count(*) FROM "Company" WHERE name LIKE 'DmSmoke Solo %')::text;`
  );
  console.log(`\n(cleanup: leftover throwaway users/dm-channels/companies = ${left})`);
  // The seeded rows this script relies on must be exactly as it found them.
  const seedIntact = psql(
    `SELECT count(*)::text FROM "User" WHERE "companyId" = 'demo-nimbus' AND "deletedAt" IS NULL;`
  );
  console.log(`(seed check: live demo-nimbus users = ${seedIntact} — expected 5)`);
  if (seedIntact !== "5") {
    pass = false;
    console.error("  FAIL  the seeded demo workspace was left altered");
  }
}

console.log(`\n${pass ? "PASS" : "FAIL"} — chat DM entry point + chat-008`);
process.exit(pass ? 0 : 1);
