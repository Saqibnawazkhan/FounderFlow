/*
 * Chat: create-a-channel and direct-message smoke test.
 *
 * smoke-chat.mjs covers reading and posting in a channel that already exists.
 * This one covers the two things that were UNREACHABLE until the DM +
 * create-channel work landed, and it exists because the failure it guards
 * against does not look like a red test — it looks like a green one.
 * `createChannelAction` shipped complete, correct, and with NO CALLER: 568 unit
 * tests passed while a brand-new workspace could reach /chat and find no way to
 * start a conversation at all. A unit test of an action cannot tell you that
 * anybody can press it. Only a browser can.
 *
 * So every assertion below is deliberately end to end:
 *
 *  - the rail exposes a "New channel" control, it opens a dialog, and creating
 *    a channel lands the browser on /chat/<its slug>
 *  - that channel is in the database, scoped to the workspace, with exactly one
 *    member — its creator, as channel "owner". createChannelAction writes the
 *    channel and that membership in ONE transaction; a channel that committed
 *    without its owner row would be invisible to everyone, forever, including
 *    the person who just made it
 *  - a "New direct message" control opens the people picker, choosing a
 *    teammate lands on /chat/dm-…, and a message sends there and renders
 *  - IDEMPOTENCY: picking the SAME teammate a second time lands on the SAME
 *    slug, and the pair still has exactly one row in the database
 *  - PRIVACY: a third user who is not in that DM neither sees it in their rail
 *    nor can reach it by URL — and the answer is not-found, never 403, because
 *    a 403 confirms the conversation exists
 *  - the recipient is actually pinged: an unread badge in their rail, and the
 *    Notification row that the `event: "dm"` fan-out in sendMessageAction
 *    writes for a body containing no @mention at all
 *
 * Seed assumptions: company demo-nimbus. demo@founderflow.app (Saqib Nawaz) is
 * admin, fatima@nimbus.app (Fatima Sheikh) is a plain member, ali@nimbus.app
 * (Ali Raza) is the uninvolved third party. Everything it creates is removed in
 * `finally`, including on failure — and a DM that already existed before the
 * run is deliberately reused and left in place.
 */

import { mkdirSync } from "node:fs";
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
const SMOKE_IP = "10.98.0.3";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";
const STAMP = Date.now().toString().slice(-6);

mkdirSync(OUT, { recursive: true });

// Pinned to the local docker Postgres. `new PrismaClient()` would read the
// root .env, which points at production — see scripts/_local-db.mjs.
const db = localDb();

const SENDER_EMAIL = "demo@founderflow.app";
const RECIPIENT_EMAIL = "fatima@nimbus.app";
const OUTSIDER_EMAIL = "ali@nimbus.app";
const PASSWORD = "demo123";

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

/** The current pathname, read from the browser rather than from page.url(). */
function pathOf(page) {
  return page.evaluate(() => location.pathname);
}

/**
 * Click one of the rail's icon-only "+" controls and wait for its dialog.
 *
 * `aria-label` is the ONLY accessible name those buttons have — ChannelRail's
 * SectionHeader renders a bare <Plus/> icon — so it is both the honest
 * selector and a thing worth asserting on: lose the label and the control
 * becomes unnameable to a screen reader as well as to this script.
 *
 * Waits for any PREVIOUS dialog to leave the DOM first. Radix animates a
 * close, so a `[role="dialog"]` that is still fading out would otherwise
 * satisfy the wait below and hand back the wrong modal's fields.
 */
async function openRailDialog(page, ariaLabel) {
  const cleared = await page
    .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!cleared) {
    // A dialog still standing would swallow the click below — Puppeteer aims
    // at coordinates and does not notice an overlay in the way, so the click
    // would silently land on Radix's scrim and this helper would report a
    // dialog that was on its way out. Escape is what a reader would press.
    await page.keyboard.press("Escape");
    await page
      .waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 })
      .catch(() => {});
  }

  const trigger = await page.$(`button[aria-label="${ariaLabel}"]`);
  if (!trigger)
    return { opened: false, reason: `no button[aria-label="${ariaLabel}"] in the rail` };

  await trigger.click();
  const appeared = await page
    .waitForSelector('[role="dialog"]', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return { opened: false, reason: "the control is there, but no dialog opened" };

  const title = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog ? (dialog.innerText || "").trim().split("\n")[0] : null;
  });
  return { opened: true, title };
}

/** Wait for a client-side router.push to actually land somewhere new. */
async function waitForPathChange(page, from, timeout = 20000) {
  const moved = await page
    .waitForFunction((prev) => location.pathname !== prev, { timeout }, from)
    .then(() => true)
    .catch(() => false);
  return moved ? pathOf(page) : null;
}

/** Wait for a client-side router.push to land on a route with this prefix. */
async function waitForPathPrefix(page, prefix, timeout = 20000) {
  const landed = await page
    .waitForFunction((pfx) => location.pathname.startsWith(pfx), { timeout }, prefix)
    .then(() => true)
    .catch(() => false);
  return landed ? pathOf(page) : null;
}

/**
 * Pick a teammate out of the open <NewDmModal>, returning the word the row
 * advertised before the click — "Message" for a pair with no history, "Open"
 * for one the query layer already found a DM for. That word is the visible
 * half of the `existingSlug` shortcut, so reading it is how we tell a genuine
 * create apart from a plain navigation.
 */
async function pickTeammate(page, name) {
  const handle = await page.evaluateHandle((needle) => {
    const rows = Array.from(document.querySelectorAll('[role="dialog"] li button'));
    return rows.find((b) => (b.textContent || "").includes(needle)) ?? null;
  }, name);
  const el = handle.asElement();
  if (!el) return null;

  const word = await el.evaluate((b) => {
    const text = b.textContent || "";
    if (text.includes("Open")) return "Open";
    if (text.includes("Message")) return "Message";
    return "(no action word)";
  });
  await el.click();
  return word;
}

/** Every href in the rail — one <nav> holds both the Channels and Direct sections. */
function railHrefs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('nav[aria-label="Channels"] a')).map((a) =>
      a.getAttribute("href")
    )
  );
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });
  console.log("== chat dm smoke ==");

  const channelName = `smoke dm ${STAMP}`;
  const dmBody = `dm smoke ${STAMP}`;

  let companyId = null;
  let createdChannelId = null;
  let createdSlug = null;
  // Set ONLY when this run created the DM. One that was already there is
  // somebody's real conversation and must survive the cleanup.
  let dmChannelId = null;
  let dmSlug = null;

  try {
    const [sender, recipient, outsider] = await Promise.all([
      db.user.findFirst({
        where: { email: SENDER_EMAIL, deletedAt: null },
        select: { id: true, name: true, companyId: true },
      }),
      db.user.findFirst({
        where: { email: RECIPIENT_EMAIL, deletedAt: null },
        select: { id: true, name: true },
      }),
      db.user.findFirst({
        where: { email: OUTSIDER_EMAIL, deletedAt: null },
        select: { id: true, name: true },
      }),
    ]);
    if (!sender || !recipient || !outsider) {
      throw new Error("seed users missing — run npm run db:seed:local");
    }
    companyId = sender.companyId;

    // Mirrors dmKeyFor() in lib/auth/channel-permissions.ts: the two ids,
    // SORTED, joined with ":". Sorting is the anti-fork rule, and recomputing
    // it here is what lets the database assertions below name the pair
    // directly instead of trusting whatever URL the UI happened to land on.
    const dmKey = [sender.id, recipient.id].sort().join(":");
    const derivedSlug = `dm-${dmKey.replace(/:/g, "_")}`;
    const preExistingDm = await db.channel.findFirst({
      where: { companyId, dmKey },
      select: { id: true, slug: true },
    });
    if (preExistingDm) {
      console.log(`  ..  a DM for this pair already exists (${preExistingDm.slug}) — it will be`);
      console.log("      reused and left in place rather than torn down");
    }
    const expectedDmSlug = preExistingDm ? preExistingDm.slug : derivedSlug;

    // ── the admin creates a channel from the rail ───────────────────────
    const adminCtx = await browser.createBrowserContext();
    const admin = await adminCtx.newPage();
    await admin.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
    wire(admin);
    await signIn(admin, SENDER_EMAIL, PASSWORD);

    await admin.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
    await admin.waitForSelector('nav[aria-label="Channels"]', { timeout: 20000 });
    const startPath = await pathOf(admin);

    // THE HOLE THAT STARTED THIS WHOLE PIECE OF WORK. If this control ever
    // disappears the action is unreachable again and chat becomes read-only
    // for anyone not already in a channel — with every unit test still green.
    const channelDialog = await openRailDialog(admin, "New channel");
    if (!channelDialog.opened) {
      fail("new-channel control", channelDialog.reason);
    } else {
      ok(`the rail's "New channel" control opens a dialog (${channelDialog.title})`);

      const nameInput = await admin.$('[role="dialog"] input[placeholder="growth"]');
      if (!nameInput) {
        fail("new-channel form", "no name input in the dialog");
      } else {
        await nameInput.type(channelName);
        await admin.click('[role="dialog"] button[type=submit]');

        const landed = await waitForPathChange(admin, startPath);
        if (landed && landed.startsWith("/chat/")) {
          createdSlug = landed.replace("/chat/", "");
          ok(`creating a channel lands the browser on its own route (${landed})`);
        } else {
          fail("create-channel navigation", `still on ${landed ?? startPath}`);
        }
      }
    }

    if (createdSlug) {
      const created = await db.channel.findFirst({
        where: { companyId, slug: createdSlug },
        select: { id: true, name: true, kind: true, companyId: true, createdBy: true },
      });
      if (created && created.name === channelName && created.companyId === companyId) {
        createdChannelId = created.id;
        ok(`the channel is in the database, scoped to ${created.companyId} (${created.kind})`);
      } else {
        fail(
          "channel persisted",
          `expected a "${channelName}" at slug "${createdSlug}", found ${JSON.stringify(created)}`
        );
      }

      if (createdChannelId) {
        // Exactly one member, and it is the creator as "owner". Iterated
        // rather than spot-checked so an extra row cannot hide behind a
        // passing first one: a second member on a brand-new channel would
        // mean somebody was put in a room they never asked for, and a role
        // other than "owner" would leave the creator unable to rename or
        // archive the thing they just made.
        const members = await db.channelMember.findMany({
          where: { channelId: createdChannelId },
          select: { userId: true, role: true },
        });
        const strangers = members.filter((m) => m.userId !== created.createdBy);
        const notOwner = members.filter((m) => m.role !== "owner");
        if (members.length === 1 && strangers.length === 0 && notOwner.length === 0) {
          ok("its only member is its creator, with channel role owner");
        } else {
          fail("channel membership", JSON.stringify(members));
        }
      }
    }

    await admin.screenshot({ path: `${OUT}/chat-dm-01-new-channel.png` });

    // ── open a direct message with a teammate ───────────────────────────
    const dmDialog = await openRailDialog(admin, "New direct message");
    if (!dmDialog.opened) {
      fail("new-dm control", dmDialog.reason);
    } else {
      ok(`the rail's "New direct message" control opens the picker (${dmDialog.title})`);

      const word = await pickTeammate(admin, recipient.name);
      if (word === null) {
        fail("dm candidate row", `no picker row for ${recipient.name}`);
      } else {
        const landed = await waitForPathPrefix(admin, "/chat/dm-");
        if (landed) {
          dmSlug = landed.replace("/chat/", "");
          ok(`choosing ${recipient.name} lands in a direct message (${landed})`);
        } else {
          fail("dm navigation", `expected /chat/dm-…, got ${await pathOf(admin)}`);
        }
      }
    }

    if (dmSlug) {
      const dmRow = await db.channel.findFirst({
        where: { companyId, slug: dmSlug },
        select: { id: true, kind: true, dmKey: true },
      });
      // Recorded for the teardown BEFORE it is asserted on: a DM this run
      // created must be removed even when the assertion below fails.
      if (dmRow && !preExistingDm) dmChannelId = dmRow.id;

      if (dmRow && dmRow.kind === "dm" && dmRow.dmKey === dmKey) {
        ok("the DM row carries the sorted dmKey for this pair");
      } else {
        fail("dm row", `expected kind=dm dmKey=${dmKey}, found ${JSON.stringify(dmRow)}`);
      }

      // The slug is DERIVED from the key, never generated, which is what lets
      // either side build the link — and find the row — with no lookup table.
      // If these disagree, the same pair is addressable at two URLs.
      if (dmSlug === expectedDmSlug) {
        ok("the DM's URL is the one derived from the pair's key");
      } else {
        fail("dm slug derivation", `landed on ${dmSlug}, expected ${expectedDmSlug}`);
      }

      // ── a message sends inside the DM ─────────────────────────────────
      const composer = await admin.$('[role="log"] ~ * textarea, textarea');
      if (!composer) {
        fail("dm composer", "no textarea on the DM page");
      } else {
        await composer.click();
        await admin.keyboard.type(dmBody);
        await admin.keyboard.press("Enter");
        const appeared = await admin
          .waitForFunction((t) => document.body.innerText.includes(t), { timeout: 15000 }, dmBody)
          .then(() => true)
          .catch(() => false);
        if (appeared) ok("a message sends in the DM and renders");
        else fail("dm send", "the message never appeared");
      }
      await admin.screenshot({ path: `${OUT}/chat-dm-02-conversation.png` });

      // ── idempotency: two picks, one conversation ──────────────────────
      // The highest-value assertion in this file. `@@unique([companyId, dmKey])`
      // is what GUARANTEES one conversation per pair; this is what proves that
      // guarantee is actually wired to the UI. Fork it and each person sees
      // only their own half of the history — a bug nobody ever reports,
      // because from either side it just looks like the other person went
      // quiet.
      //
      // Deliberately launched from the channel created above and NOT from
      // /chat: /chat redirects into the most recent conversation, which is now
      // this very DM, so landing there by redirect would make "the same slug"
      // true without the picker having done anything at all.
      if (createdSlug) {
        await admin.goto(`${BASE}/chat/${createdSlug}`, {
          waitUntil: "networkidle0",
          timeout: 60000,
        });
        const again = await openRailDialog(admin, "New direct message");
        if (!again.opened) {
          fail("new-dm control (second time)", again.reason);
        } else {
          const word = await pickTeammate(admin, recipient.name);
          if (word === "Open") {
            ok('the picker now offers "Open", not "Message" — it found the existing DM');
          } else {
            fail("existing-dm affordance", `the row advertised "${word}"`);
          }
          const landedAgain = await waitForPathPrefix(admin, "/chat/dm-");
          if (landedAgain === `/chat/${dmSlug}`) {
            ok("picking the same teammate twice lands in the SAME conversation");
          } else {
            fail("dm idempotency", `first ${dmSlug}, second ${landedAgain}`);
          }
        }
      }

      const dmCount = await db.channel.count({ where: { companyId, dmKey } });
      if (dmCount === 1) {
        ok("exactly one DM row exists for the pair");
      } else {
        fail("dm forked", `channel.count({ companyId, dmKey }) = ${dmCount}, expected 1`);
      }
    }

    await admin.close();
    await adminCtx.close();

    // ── privacy: a third user is not in this conversation ───────────────
    if (dmSlug) {
      const outsiderCtx = await browser.createBrowserContext();
      const stranger = await outsiderCtx.newPage();
      await stranger.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
      wire(stranger);
      await signIn(stranger, OUTSIDER_EMAIL, PASSWORD);

      await stranger.goto(`${BASE}/chat`, { waitUntil: "networkidle0", timeout: 60000 });
      await stranger.waitForSelector('nav[aria-label="Channels"]', { timeout: 20000 });
      const hrefs = await railHrefs(stranger);
      if (!hrefs.includes(`/chat/${dmSlug}`)) {
        ok(`the DM is absent from ${outsider.name}'s rail`);
      } else {
        fail("dm leak in the rail", JSON.stringify(hrefs));
      }

      // Same shape as smoke-chat's private-channel assertion, for the same
      // reason: the response must not distinguish "no permission" from "does
      // not exist". A 403 here would confirm that these two people talk.
      const res = await stranger.goto(`${BASE}/chat/${dmSlug}`, {
        waitUntil: "networkidle0",
        timeout: 60000,
      });
      const status = res ? res.status() : 0;
      const notFound = await stranger.evaluate(() =>
        /not found|404/i.test(document.body.innerText)
      );
      if (status === 404 || notFound) {
        ok("a non-participant gets not-found for a DM, not a 403");
      } else {
        fail("dm direct URL", `status ${status}, body did not read as not-found`);
      }
      await stranger.screenshot({ path: `${OUT}/chat-dm-03-outsider.png` });
      await stranger.close();
      await outsiderCtx.close();
    }

    // ── the recipient was actually pinged ───────────────────────────────
    if (dmSlug) {
      // An anchor channel that is NOT the DM: opening the DM would mark it
      // read and erase the very badge we are here to look at, and /chat would
      // redirect straight into it (newest lastMessageAt wins the landing), so
      // the destination is chosen explicitly.
      const anchor = await db.channel.findFirst({
        where: {
          companyId,
          kind: "public",
          archivedAt: null,
          ...(createdSlug ? { slug: { not: createdSlug } } : {}),
        },
        select: { slug: true },
        orderBy: { slug: "asc" },
      });

      if (!anchor) {
        console.log("  ..  no public channel to park the recipient in; skipping the badge check");
      } else {
        const recipientCtx = await browser.createBrowserContext();
        const reader = await recipientCtx.newPage();
        await reader.setExtraHTTPHeaders({ "x-real-ip": SMOKE_IP });
        wire(reader);
        await signIn(reader, RECIPIENT_EMAIL, PASSWORD);
        await reader.goto(`${BASE}/chat/${anchor.slug}`, {
          waitUntil: "networkidle0",
          timeout: 60000,
        });
        await reader.waitForSelector('nav[aria-label="Channels"]', { timeout: 20000 });

        // `[aria-label$="unread messages"]` rather than the first labelled
        // node in the row: a DM row leads with an <Avatar>, so "the first
        // aria-label" is not necessarily the unread pill.
        const badge = await reader.evaluate((slug) => {
          const link = document.querySelector(`nav[aria-label="Channels"] a[href="/chat/${slug}"]`);
          if (!link) return { present: false, pill: null, labels: [] };
          const pill = link.querySelector('[aria-label$="unread messages"]');
          return {
            present: true,
            pill: pill ? pill.getAttribute("aria-label") : null,
            labels: Array.from(link.querySelectorAll("[aria-label]")).map((n) =>
              n.getAttribute("aria-label")
            ),
          };
        }, dmSlug);

        if (!badge.present) {
          fail("recipient rail", `the DM ${dmSlug} is missing from ${recipient.name}'s rail`);
        } else if (badge.pill) {
          ok(`the recipient's rail shows the DM with an unread badge (${badge.pill})`);
        } else {
          fail(
            "unread badge",
            `no unread pill on the DM row (labels: ${JSON.stringify(badge.labels)})`
          );
        }
        await reader.screenshot({ path: `${OUT}/chat-dm-04-recipient.png` });
        await reader.close();
        await recipientCtx.close();
      }

      // The durable half of the same guarantee, REWRITTEN. This block used to
      // assert that a Notification row existed for the DM, on the reasoning that
      // without the `event: "dm"` branch a direct message is SILENT. That
      // reasoning still holds; what changed is where the signal lives. Chat now
      // passes `skipInApp` (lib/notify/fan-out.ts), so no in-app row is written
      // for a DM at all — the durable unread signal is the read watermark, which
      // is what the sidebar's Chat badge counts. Asserting the old row would fail
      // on correct code, which is the worst kind of check.
      //
      // So it asserts BOTH directions, because either one alone can pass while
      // the product is broken:
      //   1. no Notification row  — the thing the change exists to stop. A row
      //      here means chat is back in the notifications list.
      //   2. an unread message the recipient has not seen — the thing that
      //      replaced it. Zero here means the DM is silent after all, which is
      //      the original perverse outcome in a new costume.
      const strayPings = await db.notification.findMany({
        where: { userId: recipient.id, message: dmBody },
        select: { title: true, category: true },
      });
      if (strayPings.length > 0) {
        fail(
          "dm writes no notification row",
          `a DM put ${strayPings.length} row(s) in the notifications list: ${JSON.stringify(strayPings)}`
        );
      } else {
        ok("the dm wrote no notification row — chat stays out of the bell");
      }

      // The replacement signal, counted exactly as lib/queries/chat.ts does:
      // messages newer than MY watermark, in a channel I am a member of, that I
      // did not write.
      const membership = await db.channelMember.findFirst({
        where: { userId: recipient.id, channel: { slug: dmSlug } },
        select: { lastReadAt: true, channelId: true },
      });
      if (!membership) {
        fail("dm unread signal", `${recipient.name} has no membership row for ${dmSlug}`);
      } else {
        const unread = await db.message.count({
          where: {
            channelId: membership.channelId,
            deletedAt: null,
            authorId: { not: recipient.id },
            createdAt: { gt: membership.lastReadAt },
          },
        });
        if (unread < 1) {
          fail(
            "dm unread signal",
            `the DM left ${recipient.name} nothing to see: 0 unread in ${dmSlug}, so the Chat badge stays dark and no notification was written either`
          );
        } else {
          ok(`the dm is unread for the recipient (${unread}), which is what the Chat badge counts`);
        }
      }
    }
  } finally {
    // Belt-and-braces: restore the seed even if something threw. Children
    // before parents, so nothing here leans on a cascade.
    try {
      await db.notification.deleteMany({ where: { message: dmBody } });

      const mine = await db.message.findMany({ where: { body: dmBody }, select: { id: true } });
      await db.messageReaction.deleteMany({ where: { messageId: { in: mine.map((m) => m.id) } } });
      await db.message.deleteMany({ where: { body: dmBody } });

      // Channels are resolved by NAME as well as by the ids captured above, so
      // a run that died between "the UI created it" and "we wrote the id down"
      // still cleans up after itself.
      const strays = companyId
        ? await db.channel.findMany({
            where: { companyId, name: channelName },
            select: { id: true },
          })
        : [];
      const doomed = strays.map((c) => c.id);
      for (const id of [createdChannelId, dmChannelId]) {
        if (id && !doomed.includes(id)) doomed.push(id);
      }

      for (const channelId of doomed) {
        await db.channelMember.deleteMany({ where: { channelId } });
        await db.message.deleteMany({ where: { channelId } });
        await db.channel.deleteMany({ where: { id: channelId } });
      }
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
