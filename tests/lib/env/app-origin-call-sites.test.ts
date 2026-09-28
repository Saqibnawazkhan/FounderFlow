/**
 * prodready-004, the reachability half.
 *
 * `appOrigin()` in `lib/env.ts` is the single decision for the public origin.
 * It was written, reviewed and unit-tested in an earlier wave — and called by
 * nothing, so the finding was recorded as fixed while every call site still made
 * its own decision with its own `?? "http://localhost:3000"`. The tests in
 * `build-config.test.ts` cover the function; these cover the WIRING, because a
 * decision nothing calls is not a fix.
 *
 * Every assertion below is written in terms a person would notice, and the one
 * value that drives them all is a Production origin saved WITH A TRAILING SLASH
 * — `https://app.founderflow.com/` — which is what copying the origin out of a
 * browser address bar gives you, and which is a legal `.url()` value that passes
 * every existing check. Each site builds its link by concatenation, so that one
 * character turns every URL into `https://app.founderflow.com//…`.
 *
 * NOTE ON `process.env` + `vi.resetModules()`: `lib/env.ts` parses at module
 * load and `appOrigin()` reads the parsed value, so a test that changes the
 * origin has to force a re-evaluation of the whole module graph. `withAppUrl`
 * does that, and restores the variable afterwards.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = process.cwd();

const TRAILING = "https://app.founderflow.com/";
const CLEAN = "https://app.founderflow.com";

function source(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

/** Run `fn` with NEXT_PUBLIC_APP_URL set to `value` and a fresh module graph. */
async function withAppUrl<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NEXT_PUBLIC_APP_URL;
  if (value === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = value;
  vi.resetModules();
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = previous;
    vi.resetModules();
  }
}

/** Any `//` that is not the one after the scheme. */
function doubleSlashInPath(url: string): boolean {
  return url.replace("://", ":@@").indexOf("//") !== -1;
}

/* ─── the mail transport and the token signer are not what is under test ──── */

const sentEmails: Array<{ to: string; subject: string; html: string; text: string }> = [];

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (args: { to: string; subject: string; html: string; text: string }) => {
    sentEmails.push(args);
    return { delivered: true, devLogged: false };
  },
}));

vi.mock("@/lib/auth/email-verification-token", () => ({
  signEmailVerificationToken: async () => "TOKEN123",
}));

vi.mock("@lemonsqueezy/lemonsqueezy.js", () => ({
  lemonSqueezySetup: () => undefined,
}));

beforeEach(() => {
  sentEmails.length = 0;
});

/* ─────────────────────────────────────────────────────────────────────────── */

describe("prodready-004 wiring — robots.txt and the sitemap (silent SEO failure)", () => {
  it("advertises a sitemap URL a crawler can actually fetch", async () => {
    const sitemapUrl = await withAppUrl(TRAILING, async () => {
      const mod = await import("@/app/robots");
      return mod.default().sitemap as string;
    });
    expect(
      sitemapUrl,
      "robots.txt pointed Googlebot at a doubled-slash sitemap URL, which is not the " +
        "route Next serves — the sitemap is never read and nothing anywhere errors"
    ).toBe(`${CLEAN}/sitemap.xml`);
  });

  it("lists each marketing page at its canonical URL, not a doubled-slash twin", async () => {
    const urls = await withAppUrl(TRAILING, async () => {
      const mod = await import("@/app/sitemap");
      return mod.default().map((entry) => entry.url);
    });
    expect(urls).toEqual([`${CLEAN}/`, `${CLEAN}/login`, `${CLEAN}/signup`]);
  });
});

describe("prodready-004 wiring — the links in e-mail", () => {
  it("puts a clickable confirm link in the verification e-mail", async () => {
    await withAppUrl(TRAILING, async () => {
      const mod = await import("@/lib/email/verification");
      await mod.sendVerificationEmail({ userId: "u1", name: "Sam", email: "sam@example.com" });
    });
    expect(sentEmails.length, "no verification e-mail was sent").toBe(1);
    const body = sentEmails[0]!;
    const expected = `${CLEAN}/verify-email?token=TOKEN123`;
    expect(
      body.html,
      "the 'Confirm email' button in a new signup's e-mail pointed at " +
        "https://app.founderflow.com//verify-email?token=… — a URL that works in one " +
        "mail client and 404s in the next, and the account stays unverified"
    ).toContain(expected);
    expect(body.text).toContain(expected);
  });

  it("builds notification deep links onto a slash-free origin", async () => {
    const base = await withAppUrl(TRAILING, async () => {
      const mod = await import("@/lib/notify/email");
      return mod.linkBase();
    });
    expect(
      base,
      "every 'you were assigned a task' e-mail linked to https://app.founderflow.com//tasks?…"
    ).toBe(CLEAN);
    expect(doubleSlashInPath(`${base}/tasks?taskId=1`)).toBe(false);
    expect(doubleSlashInPath(`${base}/settings`)).toBe(false);
  });
});

describe("prodready-004 wiring — where a paying customer lands after checkout", () => {
  it("returns the buyer to a real settings URL", async () => {
    const appUrl = await withAppUrl(TRAILING, async () => {
      const mod = await import("@/lib/lemonsqueezy/config");
      return mod.APP_URL;
    });
    expect(
      appUrl,
      "after paying, LemonSqueezy redirected the buyer to " +
        "https://app.founderflow.com//settings?billing=success"
    ).toBe(CLEAN);
    // The composition lib/actions/billing.ts:117 performs.
    expect(doubleSlashInPath(`${appUrl}/settings?billing=success`)).toBe(false);
  });

  it("falls back to local dev rather than to a hard-coded deployment", async () => {
    const appUrl = await withAppUrl(undefined, async () => {
      const mod = await import("@/lib/lemonsqueezy/config");
      return mod.APP_URL;
    });
    expect(appUrl).toBe("http://localhost:3000");
  });
});

describe("prodready-004 wiring — the landing page's structured data", () => {
  /**
   * `app/page.tsx` did NOT share the localhost fallback: it fell back to
   * `|| "https://founderflow-seven.vercel.app"`, one specific deployment,
   * hard-coded. Two faults in one line. The hard-coded domain means the JSON-LD
   * `url` and `publisher.url` keep naming that deployment after the app moves to
   * its own domain — a wrong-but-syntactically-valid absolute URL is believed by
   * a crawler, where an obviously-local one is discarded. And it used `||`, not
   * `??`, so `NEXT_PUBLIC_APP_URL=""` fell through to it too.
   *
   * These are source assertions because importing `app/page.tsx` under vitest
   * pulls in `next/font/google`, which needs the Next build transform. The
   * behaviour they pin is nonetheless exact: no deployment hostname may be baked
   * into the landing page, and the origin must come from the one decision that
   * `metadataBase` also uses, so the canonical tag and the structured data can
   * never disagree about where this app lives.
   */
  it("bakes no deployment hostname into the landing page", () => {
    const src = source("app/page.tsx");
    expect(
      src.indexOf("vercel.app"),
      "app/page.tsx still hard-codes a production deployment hostname as its fallback " +
        "origin, so JSON-LD claims the app lives there whenever the env var is unset"
    ).toBe(-1);
  });

  it("takes its origin from the one decision", () => {
    const src = source("app/page.tsx");
    expect(src.indexOf("appOrigin")).toBeGreaterThan(-1);
    expect(
      src.indexOf("process.env.NEXT_PUBLIC_APP_URL"),
      "app/page.tsx still reads the raw variable, so it gets neither the trailing-slash " +
        "normalisation nor the production assertion"
    ).toBe(-1);
  });
});

describe("prodready-004 wiring — metadataBase", () => {
  /**
   * `app/layout.tsx` cannot be imported here either (`next/font/google`). What
   * matters for this one is smaller than it looks, and worth stating plainly
   * rather than overclaiming: WHATWG `new URL()` normalises an empty path to
   * "/", so for a bare origin `new URL("https://host/")` and
   * `new URL("https://host")` are the SAME metadataBase, and every canonical and
   * og:url tag is byte-identical before and after this change.
   *
   * The two cases where it is not identical:
   *   - a reverse-proxied sub-path origin (`https://host/app/`), where the
   *     canonical tag goes from `https://host/app/` to `https://host/app`,
   *     matching what every e-mail link and the sitemap now emit; and
   *   - a malformed or empty value, which used to throw a bare
   *     `TypeError: Invalid URL` from inside the root layout — every page 500s —
   *     and now fails in lib/env.ts naming the variable.
   */
  it("is unchanged for a bare origin, whichever way the value was pasted", () => {
    expect(new URL(TRAILING).href).toBe(new URL(CLEAN).href);
  });

  it("agrees with the e-mail links on a sub-path deployment", async () => {
    const origin = await withAppUrl("https://founderflow.com/app/", async () => {
      const mod = await import("@/lib/env");
      return mod.appOrigin();
    });
    expect(
      new URL(origin).pathname,
      "metadataBase kept a trailing slash that the rest of the app strips"
    ).toBe("/app");
  });

  it("reads the origin from the one decision", () => {
    const src = source("app/layout.tsx");
    expect(src.indexOf("appOrigin(")).toBeGreaterThan(-1);
    expect(
      src.indexOf("http://localhost:3000"),
      "app/layout.tsx still carries its own copy of the fallback"
    ).toBe(-1);
  });
});

describe("prodready-004 wiring — the duplicate-fallback ceiling", () => {
  /**
   * The defect this repo repeats most often is a comment asserting a stale fact
   * about a safety mechanism (CLAUDE.md records two that cost real damage), and
   * lib/env.ts's own comment is a list of the call sites that repeat the
   * fallback. So the list is machine-checked instead of remembered.
   *
   * It is deliberately a CEILING, not an equality: the sites under
   * `lib/actions/` belong to another agent in this same wave, and this test must
   * not go red the moment they finish. What it enforces is the direction that can
   * hurt — no file outside the declared list may read the raw variable — so the
   * sites wired here cannot regress and a NEW duplicate fallback cannot be added
   * quietly.
   */
  const MARKER = "RAW READERS REMAINING (ceiling, enforced by";

  function declaredRawReaders(): string[] {
    const src = source("lib/env.ts");
    const start = src.indexOf(MARKER);
    expect(
      start,
      `lib/env.ts no longer carries the "${MARKER}…" block this test reads`
    ).toBeGreaterThan(-1);
    const out: string[] = [];
    const lines = src.slice(start).split("\n");
    // Skip the marker line itself, then take the indented `//   <path>` lines.
    for (let i = 1; i < lines.length; i++) {
      const match = /^\s*\/\/\s{2,}([\w./-]+\.tsx?)\s*$/.exec(lines[i]!);
      if (!match) break;
      out.push(match[1]!);
    }
    return out;
  }

  const CANDIDATES = [
    "app/layout.tsx",
    "app/page.tsx",
    "app/robots.ts",
    "app/sitemap.ts",
    "lib/email/verification.ts",
    "lib/notify/email.ts",
    "lib/lemonsqueezy/config.ts",
    "lib/actions/password-reset.ts",
    "lib/actions/email-change.ts",
    "lib/actions/team.ts",
  ];

  function actualRawReaders(): string[] {
    const out: string[] = [];
    for (const file of CANDIDATES) {
      if (source(file).indexOf("process.env.NEXT_PUBLIC_APP_URL") !== -1) out.push(file);
    }
    return out;
  }

  it("declares every site that still reads the raw variable", () => {
    const declared = declaredRawReaders();
    const stray: string[] = [];
    for (const file of actualRawReaders()) {
      if (declared.indexOf(file) === -1) stray.push(file);
    }
    expect(
      stray,
      "these files read process.env.NEXT_PUBLIC_APP_URL directly and are not declared in " +
        "lib/env.ts's ceiling block. Either route them through appOrigin(), or — if the " +
        "duplication is deliberate — add them to that block so the next reader is not misled"
    ).toEqual([]);
  });

  it("no longer claims the sites this wave wired", () => {
    const declared = declaredRawReaders();
    const wired = [
      "app/layout.tsx",
      "app/page.tsx",
      "lib/email/verification.ts",
      "lib/notify/email.ts",
      "lib/lemonsqueezy/config.ts",
    ];
    const stillClaimed: string[] = [];
    for (const file of wired) {
      if (declared.indexOf(file) !== -1) stillClaimed.push(file);
    }
    expect(
      stillClaimed,
      "lib/env.ts still lists these as repeating the fallback, but they no longer do — a " +
        "comment that over-claims about a safety mechanism is this repo's most recurrent defect"
    ).toEqual([]);
  });
});
