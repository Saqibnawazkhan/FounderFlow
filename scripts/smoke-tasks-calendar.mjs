/*
 * Tasks calendar view smoke test.
 *
 * Asserts the things the user actually cares about:
 *  - a third "Calendar" tab sits beside Board and List and switches the view
 *  - the month grid renders whole Monday-start weeks (7 headers, >=35 cells)
 *  - a real seeded task lands in the cell for its deadline's LOCAL day
 *    (the jsdom tests prove the pure bucketing; only a browser proves the
 *    rendered DOM agrees, in the machine's real timezone)
 *  - the month pager moves and "This month" comes back
 *  - the chosen view survives a reload (localStorage: ff.tasks.view)
 *  - opening a task chip opens the same detail modal the board opens
 *
 * Seed assumptions: demo-nimbus, admin demo@founderflow.app. Reads one task
 * straight from the DB to derive the day it must appear on, so it does not
 * hardcode a seed date. Creates nothing; cleans up nothing.
 */

import puppeteer from "puppeteer-core";
import { localDb } from "./_local-db.mjs";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "C:/Users/USER/AppData/Local/Temp/ff-screenshots";

// Pinned to the local docker Postgres — see scripts/_local-db.mjs for why
// `new PrismaClient()` is unsafe here.
const db = localDb();

function ok(label) {
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

async function signIn(page, email, password) {
  // On a cold dev server the form paints before React hydrates; clicking then
  // performs a NATIVE submit, which (the form declares no method) becomes a GET
  // with the credentials in the query string and no sign-in at all. Retry until
  // React owns the click.
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

/** Click a button by its exact visible label. */
async function clickByText(page, text) {
  const handle = await page.evaluateHandle((t) => {
    const btns = [...document.querySelectorAll("button")];
    return btns.find((b) => b.textContent.trim() === t) ?? null;
  }, text);
  const el = handle.asElement();
  if (!el) throw new Error(`no button labelled "${text}"`);
  await el.click();
}

/** The month the pager is currently showing, e.g. "September 2026". */
async function readMonthLabel(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll("span")].find((s) =>
      /^[A-Z][a-z]+ \d{4}$/.test(s.textContent.trim())
    );
    return el ? el.textContent.trim() : null;
  });
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 1440, height: 1000 },
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*", "--disable-gpu"],
  });
  console.log("== tasks calendar smoke ==");

  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));
    page.on("console", (m) => {
      if (m.type() === "error") console.error("CONSOLE.error:", m.text());
    });

    await signIn(page, "demo@founderflow.app", "demo123");
    await page.goto(`${BASE}/tasks`, { waitUntil: "networkidle0" });

    // ── switch to the calendar ──────────────────────────────────────
    await clickByText(page, "Calendar");
    await page.waitForSelector("[data-date]", { timeout: 10000 });
    ok("Calendar tab switches the view");

    // ── grid shape ──────────────────────────────────────────────────
    const shape = await page.evaluate(() => {
      const gridRoot = document.querySelector("[data-calendar='grid']");
      const headers = [...gridRoot.querySelectorAll("div")]
        .map((d) => d.textContent.trim())
        .filter((t) => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(t));
      return {
        headers: headers.slice(0, 7),
        cells: gridRoot.querySelectorAll("[data-date]").length,
      };
    });
    if (shape.headers.join(",") === "Mon,Tue,Wed,Thu,Fri,Sat,Sun") {
      ok("week runs Monday to Sunday");
    } else {
      fail("weekday headers", JSON.stringify(shape.headers));
    }
    if (shape.cells >= 35 && shape.cells % 7 === 0) {
      ok(`month grid renders whole weeks (${shape.cells} cells)`);
    } else {
      fail("cell count", `got ${shape.cells}, expected a multiple of 7 >= 35`);
    }

    // -- navigate to a month that actually has work, then check placement --
    // The seed's tasks are not guaranteed to fall in the current month, so
    // derive the target month from the DB rather than assuming "today".
    const seeded = await db.task.findFirst({
      where: { deletedAt: null },
      orderBy: { deadline: "desc" },
      select: { title: true, deadline: true },
    });

    let monthLabel = await readMonthLabel(page);

    if (!seeded) {
      console.log("  ..  no tasks seeded; skipping the placement check");
    } else {
      const d = seeded.deadline;
      const today = new Date();
      // The calendar opens on today's month; step back to the task's month.
      const steps =
        today.getFullYear() * 12 + today.getMonth() - (d.getFullYear() * 12 + d.getMonth());
      if (steps < 0 || steps > 24) {
        fail("month navigation", `task month is ${steps} steps away, refusing to walk that far`);
      } else {
        for (let i = 0; i < steps; i++) {
          await page.click('[aria-label="Previous month"]');
        }
        monthLabel = await readMonthLabel(page);

        const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
          d.getDate()
        ).padStart(2, "0")}`;
        const landedOn = await page.evaluate((title) => {
          const chip = document.querySelector(
            `[data-calendar='grid'] [title="${CSS.escape(title)}"]`
          );
          return chip ? (chip.closest("[data-date]")?.getAttribute("data-date") ?? null) : null;
        }, seeded.title);

        if (landedOn === expected) ok(`"${seeded.title}" sits on ${expected} (${monthLabel})`);
        else fail("task placement", `expected ${expected}, got ${landedOn}`);
      }
    }

    await page.screenshot({ path: `${OUT}/tasks-calendar-01-month.png` });

    // ── a chip opens the detail modal ───────────────────────────────
    const chip = await page.$("[data-calendar='grid'] [data-date] button[title]");
    if (!chip) {
      console.log("  ..  no task chip on screen; skipping the detail-modal check");
    } else {
      await chip.click();
      const opened = await page
        .waitForSelector("[role=dialog]", { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (opened) ok("a task chip opens the detail modal");
      else fail("detail modal", "no [role=dialog] after clicking a chip");
      await page.screenshot({ path: `${OUT}/tasks-calendar-02-detail.png` });
      // Close it — an open dialog swallows the clicks the pager checks need.
      await page.keyboard.press("Escape");
      await page
        .waitForFunction(() => !document.querySelector("[role=dialog]"), { timeout: 5000 })
        .catch(() => {});
    }

    // ── pager ───────────────────────────────────────────────────────
    await page.click('[aria-label="Previous month"]');
    const prevLabel = await readMonthLabel(page);
    if (prevLabel !== monthLabel) ok(`pager moved back (${monthLabel} -> ${prevLabel})`);
    else fail("previous month", `label did not change from ${monthLabel}`);

    await clickByText(page, "This month");
    const backLabel = await readMonthLabel(page);
    const todayLabel = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });
    if (backLabel === todayLabel) ok(`This month returns to ${todayLabel}`);
    else fail("this month", `expected ${todayLabel}, got ${backLabel}`);

    // ── the view survives a reload ──────────────────────────────────
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("[data-date]", { timeout: 10000 }).catch(() => {});
    const stillCalendar = (await page.$("[data-date]")) !== null;
    const stored = await page.evaluate(() => localStorage.getItem("ff.tasks.view"));
    if (stillCalendar && stored === "calendar") ok("calendar view persists across a reload");
    else fail("view persistence", `grid=${stillCalendar} localStorage=${stored}`);
  } finally {
    await browser.close();
    await db.$disconnect();
  }

  console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
}

main().catch((err) => {
  console.error("smoke threw:", err);
  process.exit(1);
});
