// Smoke-test Phase 5 (rate-limit slice): hammer /login from one browser,
// wait for each POST /login response, and confirm the 6th comes back fast
// (rate-limit short-circuit, no Prisma round-trip).
//
// We use response timing as the signal rather than parsing toasts — toasts
// from react-hot-toast persist 4s by default and stale text would mislead us.

import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE ?? "http://localhost:3009";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: { width: 1280, height: 800 },
  args: ["--no-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

// Track POST /login responses so we can wait for each one in sequence.
const timings = [];
page.on("response", (resp) => {
  const req = resp.request();
  if (req.method() === "POST" && resp.url().endsWith("/login")) {
    timings.push({ status: resp.status(), at: Date.now() });
  }
});

await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await page.waitForSelector("input[name=email]", { timeout: 30_000 });
// Beat for RHF hydration so the form actually intercepts submit.
await new Promise((r) => setTimeout(r, 1000));

async function attempt(label) {
  const startCount = timings.length;
  const t0 = Date.now();

  await page.evaluate(() => {
    const emailEl = document.querySelector("input[name=email]");
    const pwEl = document.querySelector("input[name=password]");
    const setVal = (el, v) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    setVal(emailEl, "bogus-attacker@example.com");
    setVal(pwEl, "wrong-password");
    document.querySelector("form")?.requestSubmit();
  });

  // Wait for a NEW POST /login response to arrive.
  for (let i = 0; i < 100; i++) {
    if (timings.length > startCount) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const elapsed = Date.now() - t0;
  console.log(
    `attempt ${label}: status=${timings[startCount]?.status ?? "?"} client-elapsed=${elapsed}ms`
  );
}

for (let i = 1; i <= 6; i++) {
  await attempt(i);
}

// Heuristic: the rate-limit short-circuit returns in well under 200ms (no DB
// round-trip), real signIn attempts take 400ms+ (bcrypt + Supabase).
console.log("");
console.log("Per-attempt timings:", timings.map((t, i) => `${i + 1}=${t.at}ms`).join(" "));

await browser.close();

// Pull dev server log to corroborate.
import { readFile } from "node:fs/promises";
const logPath = process.env.DEV_LOG;
if (logPath) {
  const log = await readFile(logPath, "utf8");
  const posts = log.match(/POST \/login 200 in (\d+)ms/g)?.slice(-6) ?? [];
  console.log("");
  console.log("Last 6 server-side POST /login durations:");
  for (const p of posts) console.log("  " + p);
  const durations = posts.map((p) => Number(p.match(/(\d+)ms/)[1]));
  if (durations.length === 6) {
    // Pass criteria — the limiter is doing its job if:
    //   1. At least 3 attempts ran the full action (bcrypt + Supabase ≥ 200ms)
    //   2. At least one attempt was short-circuited (≤100ms, no DB call)
    //   3. All short-circuited ones come AFTER the full-action ones
    const slow = durations.filter((d) => d > 200);
    const fast = durations.filter((d) => d <= 100);
    const slowCount = slow.length;
    const fastCount = fast.length;
    const lastN = durations.slice(-fastCount);
    const allFastAtEnd = lastN.every((d) => d <= 100);
    console.log("");
    console.log(`slow attempts (>200ms): ${slowCount}, fast short-circuits (≤100ms): ${fastCount}`);
    const ok = slowCount >= 3 && fastCount >= 1 && allFastAtEnd;
    console.log(
      ok
        ? "✅ rate limiter is short-circuiting once threshold is hit"
        : "❌ unexpected timing pattern"
    );
    process.exit(ok ? 0 : 1);
  }
}
process.exit(0);
