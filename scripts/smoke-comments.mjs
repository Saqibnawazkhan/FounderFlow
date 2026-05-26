/*
 * End-to-end smoke for comments + @mentions.
 *
 * Flow:
 *  1. Log in as seed admin (demo@founderflow.app / demo123).
 *  2. Open /tasks, click the first task's comment button → modal opens.
 *  3. Post a comment with @Ali-Raza in the body.
 *  4. Verify the comment appears in the thread with a mention chip.
 *  5. Log out, log in as Ali (ali@nimbus.app / demo123).
 *  6. Visit /notifications and assert the "mentioned you" row is there.
 *
 * Uses isolated browser contexts for admin + Ali (different cookies).
 */

import puppeteer from "puppeteer-core";

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const STAMP = Date.now().toString().slice(-6);
const BODY = `Comment smoke ${STAMP} — please review @Ali-Raza`;

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
  console.log("== comments smoke ==");

  // ── Admin context ─────────────────────────────────────────────────────
  const adminPage = await browser.newPage();
  await adminPage.setViewport({ width: 1440, height: 1000 });
  await signIn(adminPage, "demo@founderflow.app", "demo123");
  ok("signed in as seed admin");

  await adminPage.goto(`${BASE}/tasks`, { waitUntil: "networkidle0" });

  // Click the first comment button on the board. The aria-label starts with
  // either "Open comments" or "Add a comment".
  const commentBtn = await adminPage.waitForSelector(
    "button[aria-label^='Add a comment'], button[aria-label^='Open comments']",
    { timeout: 8000 }
  );
  await commentBtn.click();
  ok("opened comment modal");

  // Wait for the composer.
  const textarea = await adminPage.waitForSelector("textarea", { timeout: 5000 });
  await textarea.type(BODY);
  await adminPage.click("button[type=submit]");
  // Wait for the new comment to appear in the thread.
  await adminPage.waitForFunction(
    (snippet) => {
      const articles = Array.from(document.querySelectorAll("article"));
      return articles.some((a) => a.textContent && a.textContent.includes(snippet));
    },
    { timeout: 10000 },
    `Comment smoke ${STAMP}`
  );
  ok("comment posted and rendered");

  // Verify the @Ali-Raza token got rendered as a chip (a styled span).
  const hasChip = await adminPage.$$eval(
    "article span",
    (spans, name) =>
      spans.some(
        (s) =>
          s.textContent === `@${name}` &&
          (s.className.includes("bg-cyan") || s.className.includes("text-cyan"))
      ),
    "Ali Raza"
  );
  if (hasChip) ok("@Ali-Raza rendered as mention chip");
  else fail("mention chip rendering", "no styled span found for @Ali Raza");

  await browser.close();

  // ── Recipient context — fresh browser to avoid cookie collision ───────
  const browser2 = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox"],
  });
  const aliPage = await browser2.newPage();
  await aliPage.setViewport({ width: 1440, height: 1000 });
  await signIn(aliPage, "ali@nimbus.app", "demo123");
  ok("signed in as Ali (mentioned user)");

  await aliPage.goto(`${BASE}/notifications`, { waitUntil: "networkidle0" });

  // The notification message includes the comment body snippet.
  const notifBodySnippet = `Comment smoke ${STAMP}`;
  const found = await aliPage
    .waitForFunction(
      (snippet) => document.body.textContent && document.body.textContent.includes(snippet),
      { timeout: 8000 },
      notifBodySnippet
    )
    .catch(() => null);
  if (found) ok("notification with comment snippet is present");
  else fail("notification fan-out", `looking for "${notifBodySnippet}"`);

  // The notification title is "{author} mentioned you".
  const hasMentionTitle = await aliPage.evaluate(() =>
    document.body.textContent?.includes("mentioned you")
  );
  if (hasMentionTitle) ok("notification title says 'mentioned you'");
  else fail("notification title", "'mentioned you' text not found");

  await browser2.close();
  console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
}

main().catch((err) => {
  console.error("smoke threw:", err);
  process.exit(1);
});
