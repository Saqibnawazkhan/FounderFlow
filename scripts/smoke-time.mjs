/*
 * End-to-end smoke for time tracking.
 *
 * Flow:
 *  1. Log in as seed admin → topbar shows "Clock in" pill.
 *  2. Click pill → start modal opens.
 *  3. Submit (no task, blank note) → entry created; pill turns into running timer.
 *  4. Visit /time → entry visible in the table.
 *  5. Click pill again → stop modal opens; submit → entry closes; row shows duration.
 *  6. (Admin) Click the pencil to edit the just-closed entry; bump clockOutAt
 *     forward by 30 min; save; verify the edited marker (✎) appears.
 *
 * Stops dev impl assumes seed admin is `demo@founderflow.app / demo123` and
 * has the `admin` role (per prisma/seed.ts).
 */

import puppeteer from "puppeteer-core";

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

function ok(label) {
  console.log(`  ok  ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  process.exitCode = 1;
}

async function signIn(page, email, password) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
  await page.type("input[type=email]", email);
  await page.type("input[type=password]", password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }),
    page.click("button[type=submit]"),
  ]);
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  console.log("== time tracking smoke ==");
  await signIn(page, "demo@founderflow.app", "demo123");
  ok("signed in as seed admin");

  // ── 1) Find the topbar clock pill (idle state has "Clock in" aria-label)
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
  // Widget self-loads via getOpenEntryAction — give it a moment.
  await new Promise((r) => setTimeout(r, 800));
  const idlePill = await page
    .waitForSelector("button[aria-label='Clock in']", { timeout: 5000 })
    .catch(() => null);
  if (!idlePill) {
    fail("idle clock pill present", "expected aria-label='Clock in'");
    await browser.close();
    return;
  }
  ok("idle clock pill found");

  // ── 2) Open start modal + clock in
  await idlePill.click();
  await page.waitForSelector("button[type=submit]", { timeout: 5000 });
  // Pick the "Clock in" submit (the start modal's primary action).
  // We don't pick a task — leave the select on "Untagged work".
  await page.click("button[type=submit]");
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("button[aria-label]")).some((b) =>
        (b.getAttribute("aria-label") || "").startsWith("Clocked in,")
      ),
    { timeout: 8000 }
  );
  ok("clocked in — running pill now visible");

  // ── 3) /time page shows the entry
  await page.goto(`${BASE}/time`, { waitUntil: "networkidle0" });
  const rowFound = await page
    .waitForFunction(
      () => {
        const text = document.body.textContent || "";
        return text.includes("Running");
      },
      { timeout: 5000 }
    )
    .catch(() => null);
  if (rowFound) ok("/time table shows Running row");
  else fail("/time table running row", "no 'Running' badge");

  // ── 4) Stop modal + clock out
  await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 500));
  const runningPill = await page.$("button[aria-label^='Clocked in']");
  if (!runningPill) {
    fail("running pill before stop", "no aria-label^='Clocked in'");
    await browser.close();
    return;
  }
  await runningPill.click();
  // The stop modal has a "Clock out" submit button (only its submit type
  // matches; the "Keep going" cancel button is type=button).
  await page.waitForSelector("button[type=submit]", { timeout: 5000 });
  await page.click("button[type=submit]");
  await page.waitForFunction(() => !!document.querySelector("button[aria-label='Clock in']"), {
    timeout: 8000,
  });
  ok("clocked out — idle pill back");

  // ── 5) Edit modal flow (admin only)
  await page.goto(`${BASE}/time`, { waitUntil: "networkidle0" });
  const editBtn = await page.waitForSelector("button[aria-label^='Edit time entry']", {
    timeout: 5000,
  });
  await editBtn.click();
  // Modify the clockOutAt input by +30 min. Simplest: read current value,
  // adjust, re-set.
  await page.waitForSelector("input[type=datetime-local]", { timeout: 5000 });
  const outVal = await page.$$eval("input[type=datetime-local]", (els) =>
    els.length >= 2 ? els[1].value : ""
  );
  if (!outVal) {
    fail("edit modal clockOut field", "expected a value");
    await browser.close();
    return;
  }
  const bumped = new Date(outVal);
  bumped.setMinutes(bumped.getMinutes() + 30);
  const pad = (n) => n.toString().padStart(2, "0");
  const newOut = `${bumped.getFullYear()}-${pad(bumped.getMonth() + 1)}-${pad(bumped.getDate())}T${pad(bumped.getHours())}:${pad(bumped.getMinutes())}`;
  await page.$$eval(
    "input[type=datetime-local]",
    (els, v) => {
      const nat = els[1];
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(nat, v);
      nat.dispatchEvent(new Event("input", { bubbles: true }));
      nat.dispatchEvent(new Event("change", { bubbles: true }));
    },
    newOut
  );
  await page.click("button[type=submit]");
  await page.waitForFunction(() => (document.body.textContent || "").includes("✎"), {
    timeout: 8000,
  });
  ok("admin edit landed — ✎ marker shown");

  await browser.close();
  console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
}

main().catch((err) => {
  console.error("smoke threw:", err);
  process.exit(1);
});
