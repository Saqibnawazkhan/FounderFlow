/*
 * Cross-content search smoke test (Phase H).
 *
 * The palette's two hard properties are SECURITY properties, and neither one
 * can be proved by a unit test of lib/queries/search.ts. A unit test calls the
 * query with a role it chose itself; it cannot tell you that the session the
 * browser actually carries resolves to that role, that the finance groups are
 * absent from the rendered sheet rather than merely empty in the payload, or
 * that a private channel's text stays out of a stranger's results once a real
 * cookie, a real `requireScopedSession()` and a real GIN index are in the
 * path. Only a browser can. So the two bolded acceptance criteria —
 *
 *   • a member gets NO finance results
 *   • a term that exists only in a private channel I am not in returns nothing
 *
 * — are asserted here, end to end, and everything else in this file exists to
 * stop those two from passing for the wrong reason.
 *
 * WHY THE NEGATIVE ASSERTIONS ARE PAIRED WITH POSITIVE ONES. "No results" is
 * the answer a completely broken search gives to every question. A script that
 * only checked the two negatives would go green if the palette never opened,
 * if the member's session had silently expired, or if the migration behind
 * `Message.searchVector` had never been applied. Each negative below therefore
 * has a control that proves the same pipeline DOES return the row it is
 * supposed to:
 *
 *   • the admin finds the expense (2) before the member fails to (3)
 *   • the member finds a PUBLIC channel message (control) before she fails to
 *     find the private one (4)
 *   • a member of the private channel finds the message (5) before the
 *     tombstoned version of it disappears (6)
 *
 * WHY THE NEGATIVES ARE COUNTED, NOT LABELLED. The group headings come from
 * `t.nav.*` (lib/i18n/strings.ts), so a workspace running in Urdu renders
 * "مالیات" where this script would look for "Finance" — and an assertion that
 * says "there is no heading called Finance" would then pass on a workspace
 * that was leaking every expense in it. Every negative assertion is written
 * against the number of groups the sheet rendered, which no dictionary can
 * change. Labels are only ever used to assert that something IS present, where
 * a locale mismatch fails loudly instead of silently.
 *
 * Seed assumptions: company demo-nimbus. demo@founderflow.app (Saqib Nawaz) is
 * admin, fatima@nimbus.app (Fatima Sheikh) is a plain member with no tasks of
 * her own. Everything it creates — one expense, one private channel, two
 * messages — is removed in `finally`, including on failure.
 */

import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";
const STAMP = Date.now().toString().slice(-6);

mkdirSync(OUT, { recursive: true });

// Pinned to the local docker Postgres. `new PrismaClient()` would read the
// root .env, which points at production — see scripts/_local-db.mjs.
const db = localDb();

const ADMIN_EMAIL = "demo@founderflow.app";
const MEMBER_EMAIL = "fatima@nimbus.app";
const PASSWORD = "demo123";

/**
 * The run's nonces are LETTERS ONLY, and that is load-bearing rather than
 * tidy. A message is indexed by `to_tsvector('english', body)` and searched
 * with `websearch_to_tsquery('english', term)`; a token carrying digits or
 * punctuation ("zq-481920") lexes through a different branch of the Postgres
 * parser on each side and can split, or drop out entirely. A nonsense WORD
 * goes through both sides identically — the English stemmer has nothing to
 * strip off it — so a miss below means search is broken, not that the fixture
 * was unlexable. The digits of the timestamp are mapped to letters for the
 * same reason, and keep two runs of this script from colliding.
 */
const ALPHA_STAMP = STAMP.split("")
  .map((d) => "abcdefghij"[Number(d)])
  .join("");
/** Appears ONLY in an expense description. */
const FINANCE_NONCE = `zqfin${ALPHA_STAMP}`;
/** Appears ONLY in a message inside a private channel the member is not in. */
const PRIVATE_NONCE = `zqpriv${ALPHA_STAMP}`;
/** Appears ONLY in a message inside a public channel everyone can read. */
const PUBLIC_NONCE = `zqpub${ALPHA_STAMP}`;

/** Group headings, English. Used ONLY to assert presence — see the header. */
const FINANCE_LABELS = ["Finance", "Budgets"];
const CHAT_LABEL = "Chat";
const TASKS_LABEL = "Tasks";

/** The palette's text field. Every DOM helper below anchors on it. */
const PALETTE_INPUT = '[role="dialog"] input[role="combobox"]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Open the palette with the shortcut the product actually binds: ⌘K / Ctrl-K,
 * from the `keydown` listener in components/layout/topbar.tsx. The topbar's
 * search button opens the same sheet and would be a steadier target, but the
 * shortcut is the thing a user reaches for and it depends on hydration — so
 * pressing it here is also the only check that it still works.
 *
 * The handler TOGGLES (`setPaletteOpen((open) => !open)`), which is why every
 * attempt re-tests whether the sheet is already up before pressing again: a
 * blind second press closes the palette the first one opened, and the retry
 * loop would then hunt a sheet it was itself dismissing.
 */
async function openPalette(page) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (await page.$(PALETTE_INPUT)) return;
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyK");
    await page.keyboard.up("Control");
    const up = await page
      .waitForSelector(PALETTE_INPUT, { timeout: 2500 })
      .then(() => true)
      .catch(() => false);
    if (up) return;
  }
  throw new Error("the command palette never opened on Ctrl-K");
}

async function closePalette(page) {
  if (!(await page.$(PALETTE_INPUT))) return;
  await page.keyboard.press("Escape");
  await page
    .waitForFunction(() => !document.querySelector('[role="dialog"] input[role="combobox"]'), {
      timeout: 5000,
    })
    .catch(() => {});
}

/**
 * Wait until the workspace half of the palette has answered THIS term.
 *
 * The component sets `searching` synchronously with the keystroke — before the
 * 200ms debounce, let alone the round trip — and clears it only when a
 * response whose request id is still current comes back. The spinner is
 * therefore the one honest "still asking" signal in the DOM, and waiting for
 * it to appear before waiting for it to go is what stops this helper reading
 * the PREVIOUS term's settled results and calling them this term's. Getting
 * that wrong would turn every negative assertion below into a coin flip.
 */
async function settle(page) {
  await page
    .waitForFunction(() => !!document.querySelector('[role="dialog"] .animate-spin'), {
      timeout: 2500,
    })
    .catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[role="dialog"] .animate-spin'), {
    timeout: 30000,
  });
  // One paint for the groups that arrived with the response.
  await sleep(300);
}

/** Everything the rendered sheet is currently saying, as plain data. */
function readPalette(page) {
  return page.evaluate(() => {
    const input = document.querySelector('[role="dialog"] input[role="combobox"]');
    if (!input) return { open: false, query: "", groups: [], options: [], noResults: false };
    const dialog = input.closest('[role="dialog"]');

    // The palette numbers every row with `${listboxId}-opt-${index}`, and that
    // index IS its position in the flat arrow-key sequence. Reading it back is
    // what lets this script drive the keyboard to a specific hit instead of
    // assuming the one it wants is first.
    const indexOf = (el) => {
      const id = el.getAttribute("id") || "";
      const at = id.lastIndexOf("-opt-");
      return at === -1 ? -1 : Number(id.slice(at + 5));
    };
    const readOption = (el) => ({
      index: indexOf(el),
      text: (el.innerText || "").replace(/\s+/g, " ").trim(),
      selected: el.getAttribute("aria-selected") === "true",
    });

    return {
      open: true,
      query: input.value,
      // Nav rows are NOT inside a [role="group"]; only the server's content
      // groups are. So this list is exactly "what came back from the search".
      groups: Array.from(dialog.querySelectorAll('[role="group"]')).map((g) => ({
        label: g.getAttribute("aria-label") || "",
        rows: Array.from(g.querySelectorAll('[role="option"]')).map(readOption),
      })),
      options: Array.from(dialog.querySelectorAll('[role="option"]')).map(readOption),
      noResults: !dialog.querySelector('[role="listbox"]'),
    };
  });
}

/** Open a fresh palette, type `term`, wait for the answer, report the sheet. */
async function search(page, term) {
  // Always from a fresh sheet: opening resets the query, the results and the
  // request id, so no answer from the previous term can survive into this one.
  await closePalette(page);
  await openPalette(page);

  // That reset (`setQuery("")`, in the palette's open effect) runs AFTER the
  // input is in the DOM — which is the moment `openPalette` returns. React
  // schedules passive effects on its own clock, so typing into that gap can
  // have its first characters wiped, and the search then honestly answers a
  // term nobody typed. Hence: pause for the effect, then verify what actually
  // landed in the box rather than trusting that the keystrokes stuck.
  await sleep(250);
  let typed = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.type(PALETTE_INPUT, term, { delay: 20 });
    typed = await page.$eval(PALETTE_INPUT, (el) => el.value);
    if (typed === term) break;
    await page.$eval(PALETTE_INPUT, (el) => {
      el.select();
    });
    await page.keyboard.press("Backspace");
    await sleep(150);
  }
  if (typed !== term) {
    throw new Error(`could not get "${term}" into the palette — the box reads "${typed}"`);
  }

  await settle(page);
  return readPalette(page);
}

/**
 * Flatten a sheet to one string, for `includes` checks and failure detail.
 *
 * The two empty cases are spelled differently on purpose: "the palette painted
 * its No-results copy" and "the palette painted a listbox with nothing in it"
 * are different bugs, and a failure message that called both of them "(empty)"
 * would send the next reader to the wrong file.
 */
function sheetText(snap) {
  if (snap.options.length === 0) {
    return snap.noResults ? "(the palette's No-results state)" : "(a listbox with no rows)";
  }
  return snap.options.map((o) => o.text).join(" | ");
}

/** Every group label the sheet rendered. */
function labelsOf(snap) {
  return snap.groups.map((g) => g.label);
}

/**
 * Walk the arrow keys from wherever the highlight is to `targetIndex`, then
 * press Enter. ArrowDown wraps modulo the row count (the palette's own
 * handler does), so the step count is taken modulo too.
 */
async function arrowToAndEnter(page, snap, targetIndex) {
  const count = snap.options.length;
  const active = snap.options.find((o) => o.selected);
  const from = active ? active.index : 0;
  const steps = (((targetIndex - from) % count) + count) % count;
  for (let i = 0; i < steps; i++) await page.keyboard.press("ArrowDown");

  // Waited for, not read once: the last ArrowDown's re-render lands a tick
  // after the key event resolves, and a snapshot taken in that gap would
  // report the PREVIOUS highlight — so Enter would be pressed on a row this
  // helper never chose, and the failure would look like a routing bug.
  const landed = await page
    .waitForFunction(
      (want) => {
        const el = document.querySelector('[role="dialog"] [role="option"][aria-selected="true"]');
        if (!el) return false;
        const id = el.getAttribute("id") || "";
        const at = id.lastIndexOf("-opt-");
        return at !== -1 && Number(id.slice(at + 5)) === want;
      },
      { timeout: 5000 },
      targetIndex
    )
    .then(() => true)
    .catch(() => false);

  if (!landed) {
    const moved = await readPalette(page);
    const nowOn = moved.options.find((o) => o.selected);
    return { landed: false, detail: `highlight sat on ${nowOn ? nowOn.index : "nothing"}` };
  }
  await page.keyboard.press("Enter");
  return { landed: true };
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });
  console.log("== search smoke ==");

  let transactionId = null;
  let privateChannelId = null;
  let privateMessageId = null;
  let publicMessageId = null;

  try {
    const admin = await db.user.findFirst({
      where: { email: ADMIN_EMAIL, deletedAt: null },
      select: { id: true, name: true, companyId: true, role: true },
    });
    if (!admin || !admin.companyId) throw new Error(`no seeded admin ${ADMIN_EMAIL}`);
    const companyId = admin.companyId;

    const memberUser = await db.user.findFirst({
      where: { email: MEMBER_EMAIL, deletedAt: null },
      select: { id: true, role: true },
    });
    if (!memberUser) throw new Error(`no seeded member ${MEMBER_EMAIL}`);
    // Stated as a seed fact, checked as a precondition: if this account were
    // ever promoted, assertion 3 would be asserting nothing at all.
    if (memberUser.role !== "member") {
      throw new Error(`${MEMBER_EMAIL} is "${memberUser.role}", not "member" — fix the seed`);
    }

    // ── admin ───────────────────────────────────────────────────────
    const adminCtx = await browser.createBrowserContext();
    const adminPage = await adminCtx.newPage();
    wire(adminPage);
    await signIn(adminPage, ADMIN_EMAIL, PASSWORD);
    await adminPage.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 });

    // ── 1. a seeded task, found by part of its title, opened with Enter ──
    const seededTask = await db.task.findFirst({
      // The same three filters lib/queries/search.ts applies, so the fixture
      // cannot be a row the feature is right to hide.
      where: { companyId, deletedAt: null, project: { deletedAt: null } },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true },
    });
    if (!seededTask) throw new Error("no seeded task with a live project to search for");

    // A CONTIGUOUS prefix, not two words picked out of the title: task search
    // is a SQL `contains`, so "Design landing" (words 1 and 3 of "Design new
    // landing page") matches nothing and the failure would read as a search
    // bug rather than a bad fixture.
    const taskTerm = seededTask.title.slice(0, 16).trim();
    if (taskTerm.length < 2)
      throw new Error(`task title too short to search: "${seededTask.title}"`);

    const taskSheet = await search(adminPage, taskTerm);
    const tasksGroup = taskSheet.groups.find((g) => g.label === TASKS_LABEL);
    if (!tasksGroup) {
      fail(`a Tasks group for "${taskTerm}"`, `groups: ${JSON.stringify(labelsOf(taskSheet))}`);
    } else {
      const row = tasksGroup.rows.find((r) => r.text.includes(seededTask.title));
      if (!row) {
        fail(
          "the seeded task is in the Tasks group",
          `rows: ${JSON.stringify(tasksGroup.rows.map((r) => r.text))}`
        );
      } else {
        ok(`part of a task title finds it — "${taskTerm}" → "${seededTask.title}"`);
        await adminPage.screenshot({ path: `${OUT}/search-01-task-hit.png` });

        const want = `/tasks?taskId=${seededTask.id}`;
        const pressed = await arrowToAndEnter(adminPage, taskSheet, row.index);
        if (!pressed.landed) {
          fail("arrowing to the task hit", pressed.detail);
        } else {
          const opened = await adminPage
            .waitForFunction(
              (w) => location.pathname + location.search === w,
              { timeout: 15000 },
              want
            )
            .then(() => true)
            .catch(() => false);
          if (opened) ok(`Enter opens the task (${want})`);
          else fail("Enter opens the task", `expected ${want}, got ${adminPage.url()}`);
        }
      }
    }

    // ── fixtures for the finance + channel assertions ───────────────
    const expenseDescription = `Smoke search expense ${FINANCE_NONCE}`;
    const expense = await db.transaction.create({
      data: {
        companyId,
        type: "expense",
        amount: "1250.00",
        category: "Software",
        description: expenseDescription,
        date: new Date(),
        addedBy: admin.id,
        addedByName: admin.name,
      },
      select: { id: true },
    });
    transactionId = expense.id;

    // ── 2. the admin CAN see finance results ────────────────────────
    // The control for assertion 3: it proves the row exists, is indexed the
    // way the palette looks for it, and is one query away from anyone the
    // gate lets through.
    await adminPage.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 });
    const adminFinance = await search(adminPage, FINANCE_NONCE);
    const adminFinanceRow = adminFinance.options.find((o) => o.text.includes(expenseDescription));
    if (!adminFinanceRow) {
      fail("an admin finds the expense", `sheet: ${sheetText(adminFinance)}`);
    } else {
      ok("an admin searching the expense term gets the expense back");
    }
    // Secondary, and deliberately label-based: if the workspace is running in
    // Urdu this is the assertion that says so, instead of the negative ones
    // below quietly passing because no heading could ever read "Finance".
    if (labelsOf(adminFinance).some((l) => FINANCE_LABELS.includes(l))) {
      ok("the hit is filed under a finance heading");
    } else {
      fail("a finance heading for the admin", `groups: ${JSON.stringify(labelsOf(adminFinance))}`);
    }

    // A private channel the member is NOT in, and a public one she is.
    const privateSlug = `smoke-search-private-${STAMP}`;
    const privateName = `Smoke search private ${STAMP}`;
    const createdChannel = await db.channel.create({
      data: {
        companyId,
        kind: "private",
        slug: privateSlug,
        name: privateName,
        createdBy: admin.id,
        // The admin is its ONLY member. This is what makes assertion 5 a real
        // control: company role grants no back door into a private channel
        // (canSeeChannel in lib/auth/channel-permissions.ts is emphatic about
        // it), so if the admin finds this message it is because of the
        // ChannelMember row and nothing else.
        members: { create: { userId: admin.id, role: "owner" } },
      },
      select: { id: true },
    });
    privateChannelId = createdChannel.id;

    const privateMessage = await db.message.create({
      data: {
        companyId,
        channelId: privateChannelId,
        authorId: admin.id,
        authorName: admin.name,
        body: `strictly between us ${PRIVATE_NONCE} and nobody else in this workspace`,
      },
      select: { id: true },
    });
    privateMessageId = privateMessage.id;

    const publicChannel = await db.channel.findFirst({
      where: { companyId, kind: "public", archivedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    });
    if (!publicChannel) throw new Error("no public channel in demo-nimbus to use as a control");
    const publicMessage = await db.message.create({
      data: {
        companyId,
        channelId: publicChannel.id,
        authorId: admin.id,
        authorName: admin.name,
        body: `posted in the open ${PUBLIC_NONCE} for everyone in the workspace to read`,
      },
      select: { id: true },
    });
    publicMessageId = publicMessage.id;

    // ── member ──────────────────────────────────────────────────────
    const memberCtx = await browser.createBrowserContext();
    const memberPage = await memberCtx.newPage();
    wire(memberPage);
    await signIn(memberPage, MEMBER_EMAIL, PASSWORD);
    // /tasks, not /dashboard: a member is bounced off the finance surfaces,
    // and this script is not the place to re-prove that.
    await memberPage.goto(`${BASE}/tasks`, { waitUntil: "networkidle0", timeout: 60000 });

    // ── CONTROL (not one of the six) ────────────────────────────────
    // Before asking this session two questions whose right answer is
    // "nothing", prove it can answer a question at all. Without this, a
    // member whose session died on the way here would sail through both
    // negatives — the single most likely way this file goes green while the
    // product leaks.
    const memberPublic = await search(memberPage, PUBLIC_NONCE);
    if (memberPublic.options.some((o) => o.text.includes(publicChannel.name))) {
      ok("control: the member's own search works — a public-channel message comes back");
    } else {
      fail(
        "control: a member finds a public-channel message",
        `sheet: ${sheetText(memberPublic)} — the two negatives below now prove nothing`
      );
    }

    // ── 3. A MEMBER GETS NO FINANCE RESULTS ─────────────────────────
    // THE HIGHEST-VALUE ASSERTION IN THIS SCRIPT. Assertion 2 has just shown
    // that this exact term returns this exact expense for a role that may see
    // money. The same term, the same workspace, a member: the correct answer
    // is not an empty Finance section, it is no Finance section — the palette
    // renders only the groups the server sent, and for a member the server
    // never runs the transaction or budget query at all. Counting groups,
    // rather than looking for a heading by name, is what makes this assertion
    // survive a change of UI language (see the file header).
    const memberFinance = await search(memberPage, FINANCE_NONCE);
    await memberPage.screenshot({ path: `${OUT}/search-02-member-no-finance.png` });
    if (memberFinance.groups.length === 0) {
      ok("a member searching the expense term gets no result groups at all");
    } else {
      fail(
        "FINANCE LEAK: a member got workspace results for an expense term",
        `groups: ${JSON.stringify(labelsOf(memberFinance))} — rows: ${sheetText(memberFinance)}`
      );
    }
    const leakedLabels = labelsOf(memberFinance).filter((l) => FINANCE_LABELS.includes(l));
    if (leakedLabels.length > 0) {
      fail("FINANCE LEAK: a finance heading rendered for a member", JSON.stringify(leakedLabels));
    }
    if (memberFinance.options.some((o) => o.text.includes(expenseDescription))) {
      fail("FINANCE LEAK: the expense itself rendered for a member", expenseDescription);
    }

    // ── 4. a private channel's text does not exist for a non-member ──
    // A FAILURE HERE IS A DATA LEAK, NOT A COSMETIC BUG. The member is not in
    // this channel and never was; the only place this nonce exists in the
    // entire workspace is a message she is not allowed to read. One row
    // coming back means the search path found a way around
    // `visibleChannelWhere` — private conversations between colleagues,
    // readable by anyone with a search box and a guess.
    const memberPrivate = await search(memberPage, PRIVATE_NONCE);
    await memberPage.screenshot({ path: `${OUT}/search-03-member-private.png` });
    if (memberPrivate.groups.length === 0) {
      ok("a term that exists only in a private channel the member is not in returns nothing");
    } else {
      fail(
        "PRIVATE CHANNEL LEAK: a non-member got results for a private-channel term",
        `groups: ${JSON.stringify(labelsOf(memberPrivate))} — rows: ${sheetText(memberPrivate)}`
      );
    }
    if (
      memberPrivate.options.some(
        (o) => o.text.includes(privateName) || o.text.includes(PRIVATE_NONCE)
      )
    ) {
      fail("PRIVATE CHANNEL LEAK: the private message rendered for a non-member", privateName);
    }

    // ── 5. the channel's own member DOES find it ────────────────────
    // The control for 4: without this, "returns nothing" could simply mean
    // message search is broken for everyone, and assertion 4 would be green
    // for a reason that has nothing to do with permissions.
    await adminPage.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0", timeout: 60000 });
    const insiderSheet = await search(adminPage, PRIVATE_NONCE);
    const insiderRow = insiderSheet.options.find((o) => o.text.includes(privateName));
    if (insiderRow) {
      ok("a member OF that channel does find the message — assertion 4 is not vacuous");
    } else {
      fail(
        "a channel member finds their own private message",
        `sheet: ${sheetText(insiderSheet)} — assertion 4 above proves nothing`
      );
    }
    if (labelsOf(insiderSheet).includes(CHAT_LABEL)) {
      ok("the message hit is filed under the Chat heading");
    } else {
      fail("a Chat heading for the channel member", JSON.stringify(labelsOf(insiderSheet)));
    }

    // ── 6. a tombstoned message does not resurface ──────────────────
    // `Message.searchVector` is GENERATED from `body` alone and knows nothing
    // about tombstones, so the index happily keeps matching a message the
    // timeline renders as "message deleted". The `deletedAt IS NULL` filter in
    // the raw SQL is the only thing standing between a deleted message and the
    // palette, and it is written by hand — exactly the kind of line that goes
    // missing in a refactor without anything turning red.
    await db.message.update({
      where: { id: privateMessageId },
      data: { deletedAt: new Date() },
    });
    const afterDelete = await search(adminPage, PRIVATE_NONCE);
    if (afterDelete.groups.length === 0) {
      ok("a soft-deleted message is gone from search, for the people who could read it");
    } else {
      fail(
        "a tombstoned message resurfaced through search",
        `groups: ${JSON.stringify(labelsOf(afterDelete))} — rows: ${sheetText(afterDelete)}`
      );
    }
  } finally {
    // Belt-and-braces: restore the seed even if something threw. Children
    // before parents, so nothing here leans on a cascade.
    try {
      if (transactionId) {
        await db.comment.deleteMany({ where: { transactionId } });
        await db.transaction.deleteMany({ where: { id: transactionId } });
      }
      // Also by content, so a run that died between "the row was written" and
      // "we wrote its id down" still cleans up after itself.
      await db.transaction.deleteMany({ where: { description: { contains: FINANCE_NONCE } } });

      const mine = await db.message.findMany({
        where: {
          OR: [{ body: { contains: PRIVATE_NONCE } }, { body: { contains: PUBLIC_NONCE } }],
        },
        select: { id: true },
      });
      const doomedMessages = mine.map((m) => m.id);
      for (const id of [privateMessageId, publicMessageId]) {
        if (id && !doomedMessages.includes(id)) doomedMessages.push(id);
      }
      if (doomedMessages.length > 0) {
        await db.messageReaction.deleteMany({ where: { messageId: { in: doomedMessages } } });
        await db.message.deleteMany({ where: { id: { in: doomedMessages } } });
      }

      const strayChannels = await db.channel.findMany({
        where: { slug: `smoke-search-private-${STAMP}` },
        select: { id: true },
      });
      const doomedChannels = strayChannels.map((c) => c.id);
      if (privateChannelId && !doomedChannels.includes(privateChannelId)) {
        doomedChannels.push(privateChannelId);
      }
      for (const channelId of doomedChannels) {
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
