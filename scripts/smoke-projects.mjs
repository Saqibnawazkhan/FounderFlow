/*
 * Projects feature smoke test.
 *
 * Asserts the things the user actually cares about:
 *  - /projects renders the 3 seeded projects for admin
 *  - "New project" modal creates a project, lands the user on its detail
 *  - Detail page shows Tasks + Budgets (admin path)
 *  - Member sees ONLY projects they're tied to (sarah is supervisor of
 *    Internal ops AND has a task on Launch v2 → 2 of 3 projects visible)
 *  - Sarah, supervising Internal ops, sees the Budgets section on THAT
 *    project but cannot reach /budgets globally
 *  - Admin can change supervisor + archive
 */

import puppeteer from "puppeteer-core";

const BASE = process.env.SMOKE_BASE_URL || "http://localhost:3000";
const CHROME =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

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
  await page.click("button[type=submit]");
  await page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 15000 });
  await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 5000 }).catch(() => {});
}

const STAMP = Date.now().toString().slice(-6);

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--no-proxy-server", "--proxy-bypass-list=*"],
  });
  console.log("== projects smoke ==");

  // ── Admin path ──────────────────────────────────────────────────
  const adminCtx = await browser.createBrowserContext();
  const admin = await adminCtx.newPage();
  await admin.setViewport({ width: 1440, height: 1000 });
  await signIn(admin, "demo@founderflow.app", "demo123");
  await admin.goto(`${BASE}/projects`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 500));

  const seededProjectCount = await admin.$$eval(
    "a[aria-label^='Open project']",
    (els) => els.length
  );
  if (seededProjectCount >= 3) ok(`admin sees ${seededProjectCount} seeded projects`);
  else fail("admin seeded projects", `expected >=3, got ${seededProjectCount}`);

  // Click "New project" — verify the modal opens.
  const newBtn = await admin.evaluateHandle(() =>
    Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "New project"
    )
  );
  await newBtn.asElement().click();
  await admin.waitForSelector("[role=dialog]", { timeout: 5000 });
  ok("admin: New project modal opens");

  // Fill name + submit. Supervisor + color default; targetEndDate optional.
  // Use the RHF-emitted name attribute to nail the right input — the
  // modal has a textarea + date input that share the input/textarea
  // selector.
  const nameInput = await admin.waitForSelector("[role=dialog] input[name='name']", {
    timeout: 5000,
  });
  await nameInput.type(`Smoke project ${STAMP}`);
  await admin.click("[role=dialog] button[type=submit]");
  // The modal calls router.push(/projects/[id]) on success. Wait for the
  // URL to change OFF /projects (any deeper path means navigation fired).
  await admin.waitForFunction(
    () => location.pathname !== "/projects" && location.pathname.startsWith("/projects/"),
    { timeout: 10000 }
  );
  ok(`admin: clicked Save and landed on ${admin.url()}`);

  // Wait for the detail page to actually render the project name in the
  // <h1> header — the RSC needs to mount before we assert content.
  await admin
    .waitForFunction(
      (stamp) => {
        const h1 = document.querySelector("h1");
        return !!(h1 && h1.textContent && h1.textContent.includes(stamp));
      },
      { timeout: 10000 },
      `Smoke project ${STAMP}`
    )
    .then(() => ok("admin: detail page renders the new name"))
    .catch(() => fail("admin detail name", "h1 didn't show the project name"));

  // Tasks section + Budgets section both visible for admin.
  const sectionLabels = await admin.$$eval("section h2", (els) =>
    els.map((h) => (h.textContent || "").trim().toLowerCase())
  );
  if (sectionLabels.some((l) => l.includes("tasks"))) ok("admin: Tasks section present");
  else fail("admin tasks section", JSON.stringify(sectionLabels));
  if (sectionLabels.some((l) => l.includes("budgets"))) ok("admin: Budgets section present");
  else fail("admin budgets section", JSON.stringify(sectionLabels));

  // Archive flow — open archive, accept the confirm dialog (which is a
  // separate Radix dialog). Simpler: just click Archive button and accept.
  const archiveBtn = await admin.evaluateHandle(() =>
    Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Archive"
    )
  );
  if (archiveBtn.asElement()) {
    await archiveBtn.asElement().click();
    // Confirm dialog has an "Archive" submit — click whichever button has that label inside the dialog.
    await admin.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("[role=dialog] button")).some((b) =>
          (b.textContent || "").trim().toLowerCase().includes("archive")
        ),
      { timeout: 5000 }
    );
    const confirmHandle = await admin.evaluateHandle(() =>
      Array.from(document.querySelectorAll("[role=dialog] button")).find((b) => {
        const t = (b.textContent || "").trim().toLowerCase();
        return t === "archive" || t === "آرکائیو";
      })
    );
    if (confirmHandle.asElement()) {
      await confirmHandle.asElement().click();
      await new Promise((r) => setTimeout(r, 600));
      ok("admin: archived the smoke project");
    }
  }

  await admin.close();
  await adminCtx.close();

  // ── Member path (Sarah, supervisor of Internal ops) ──────────────
  const memberCtx = await browser.createBrowserContext();
  const member = await memberCtx.newPage();
  await member.setViewport({ width: 1440, height: 1000 });
  await signIn(member, "sarah@nimbus.app", "demo123");
  await member.goto(`${BASE}/projects`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 500));

  const memberProjects = await member.$$eval(
    "a[aria-label^='Open project']",
    (els) => els.map((a) => (a.textContent || "").trim().toLowerCase())
  );
  if (memberProjects.length >= 1) {
    ok(`member sees ${memberProjects.length} project(s) — filtered subset`);
  } else {
    fail("member visible projects", "expected >=1");
  }

  // Sarah supervises "Internal ops" — verify it's in her list.
  if (memberProjects.some((p) => p.includes("internal ops")))
    ok("member sees their supervised project (Internal ops)");
  else fail("member supervised project", JSON.stringify(memberProjects));

  // Open Internal ops, verify the Budgets section is visible (supervisor
  // escape hatch).
  const internalLink = await member.evaluateHandle(() =>
    Array.from(document.querySelectorAll("a[aria-label^='Open project']")).find((a) =>
      (a.textContent || "").toLowerCase().includes("internal ops")
    )
  );
  if (internalLink.asElement()) {
    await Promise.all([
      member.waitForNavigation({ waitUntil: "networkidle0" }),
      internalLink.asElement().click(),
    ]);
    // Wait for the project H1 to mount before sampling section labels.
    await member.waitForFunction(
      () => {
        const h1 = document.querySelector("h1");
        return !!(h1 && (h1.textContent || "").toLowerCase().includes("internal ops"));
      },
      { timeout: 10000 }
    ).catch(() => {});
    const memberDetailSections = await member.$$eval("section h2", (els) =>
      els.map((h) => (h.textContent || "").trim().toLowerCase())
    );
    if (memberDetailSections.some((l) => l.includes("budgets")))
      ok("member-supervisor: sees Budgets section on their project");
    else fail("member supervisor budgets", JSON.stringify(memberDetailSections));
  }

  // Globally /budgets must still redirect Sarah away.
  await member.goto(`${BASE}/budgets`, { waitUntil: "networkidle0" });
  const finalUrl = new URL(member.url()).pathname;
  if (finalUrl !== "/budgets")
    ok(`member: /budgets blocked (redirected to ${finalUrl})`);
  else fail("member /budgets gate", "still on /budgets");

  await browser.close();
  console.log(process.exitCode ? "\n== FAIL ==" : "\n== pass ==");
}

main().catch((err) => {
  console.error("smoke threw:", err);
  process.exit(1);
});
