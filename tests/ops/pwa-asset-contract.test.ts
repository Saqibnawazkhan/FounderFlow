// @vitest-environment node

/**
 * prodready-019 — the PWA shell graph, which is the part of the production
 * configuration nothing in the suite was holding.
 *
 * WHAT THE FINDING CLAIMED, AND WHAT WAS LEFT OF IT. The filing listed eight
 * unguarded config surfaces. Seven are now covered elsewhere and this file
 * deliberately does not restate them: the CSP/header builder by
 * `tests/security/csp-header.test.ts`, the build-time env table (including
 * "requires exactly these eight, so the list cannot shrink unnoticed") by
 * `tests/lib/env/build-config.test.ts`, `app/robots.ts` and `app/sitemap.ts` by
 * `tests/lib/env/app-origin-call-sites.test.ts` and
 * `tests/lib/env/self-description.test.ts`, and — the one that reads as the
 * biggest gap but is not one — every `vercel.json` cron `path` against a real
 * route file, by `tests/lib/cron/sweep-route.test.ts`, whose drift guard reads
 * `app/<path>/route.ts` for each scheduled cron and therefore goes red with an
 * ENOENT the moment a cron route is renamed without its schedule.
 *
 * What nothing held is the asset graph that the install handler in
 * `public/sw.js` and `public/manifest.json` name by string. That is the
 * surface with the sharpest edge in the whole list, because:
 *
 *   `cache.addAll(SHELL_URLS)` REJECTS ATOMICALLY. One non-2xx among those
 *   URLs and the install handler's promise never settles, so the service worker
 *   never activates and the ENTIRE offline / PWA layer silently does not come
 *   up. Not the one asset — all of it. `app/layout.tsx` records this happening
 *   for real: `app/icon.svg` and `public/icon.svg` both claimed the URL
 *   `/icon.svg`, Next resolved the collision by serving an error page, and the
 *   offline layer was gone with nothing anywhere erroring or logging.
 *
 * So existence on disk is NOT the contract, and a test that only stats files
 * would have passed throughout that outage — `public/icon.svg` was present the
 * whole time. The contract has three parts: something serves each URL, EXACTLY
 * ONE thing serves it, and it answers WITHOUT A SESSION (the worker registers
 * from the root layout, so it installs for signed-out visitors too). All three
 * are asserted below.
 *
 * `scripts/qa-production-readiness.mjs` already probes these URLs over HTTP and
 * says so in the same words, but it needs a running deployment, so it cannot
 * fail a pull request. These assertions are static and run in CI.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { authConfig } from "@/auth.config";

const ROOT = process.cwd();

function source(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

/* ───────────────────────────── reading the config ───────────────────────── */

/** The precache list, parsed out of `public/sw.js` rather than restated here. */
function shellUrls(): string[] {
  const hit = /const SHELL_URLS = \[([^\]]*)\]/.exec(source("public/sw.js"));
  if (!hit) {
    throw new Error(
      "could not find `const SHELL_URLS = [...]` in public/sw.js — if the precache list was " +
        "renamed, point this parser at the new name rather than deleting these tests"
    );
  }
  const urls: string[] = [];
  const strings = /"([^"]*)"|'([^']*)'/g;
  let m = strings.exec(hit[1]);
  while (m) {
    urls.push(m[1] || m[2]);
    m = strings.exec(hit[1]);
  }
  return urls;
}

type ManifestIcon = { src: string; sizes?: string; type?: string; purpose?: string };
type Manifest = { icons?: ManifestIcon[]; start_url?: string; scope?: string };

function manifest(): Manifest {
  return JSON.parse(source("public/manifest.json")) as Manifest;
}

/* ──────────────────────── who actually serves a URL ─────────────────────── */

/**
 * Every URL path the App Router serves from a `page` or `route` file.
 *
 * Route groups (`(app)`) and parallel slots (`@modal`) are directories that do
 * not appear in the URL, so they are walked into without contributing a
 * segment — otherwise `/dashboard` would read as missing.
 */
function appRoutes(): string[] {
  const out: string[] = [];
  walk(join(ROOT, "app"), [], out);
  return out;
}

function walk(dir: string, urlSegments: string[], out: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const name = entry.name;
      const hidden = /^\(.*\)$/.test(name) || name.charAt(0) === "@" || name.charAt(0) === "_";
      walk(join(dir, name), hidden ? urlSegments : urlSegments.concat(name), out);
    } else if (/^(page|route)\.(tsx?|jsx?)$/.test(entry.name)) {
      out.push("/" + urlSegments.join("/"));
    }
  }
}

function isFile(absPath: string): boolean {
  return existsSync(absPath) && statSync(absPath).isFile();
}

/**
 * Everything in the repo that claims `urlPath`.
 *
 * Zero claimants is a 404. TWO claimants is the `/icon.svg` outage: a file
 * under `app/` and a file under `public/` can name the same URL, and Next
 * answers the collision with an error page rather than picking one.
 */
function claimants(urlPath: string): string[] {
  const rel = urlPath.replace(/^\//, "");
  const found: string[] = [];
  if (rel !== "" && isFile(join(ROOT, "public", rel))) found.push("public/" + rel);
  if (rel !== "" && isFile(join(ROOT, "app", rel))) found.push("app/" + rel);
  if (appRoutes().indexOf(urlPath) !== -1)
    found.push("an app/ page or route handler for " + urlPath);
  return found;
}

/* ─────────────── can something without a session fetch it ───────────────── */

type AuthorizedFn = NonNullable<NonNullable<typeof authConfig.callbacks>["authorized"]>;
type AuthorizedArg = Parameters<AuthorizedFn>[0];

/** Drives the real `authorized()` callback with no session, as middleware does. */
async function anonymousAllowed(urlPath: string): Promise<boolean> {
  const authorized = (authConfig.callbacks as { authorized: AuthorizedFn }).authorized;
  return (await authorized({
    auth: null,
    request: { nextUrl: new URL("https://app.founderflow.test" + urlPath) },
  } as unknown as AuthorizedArg)) as boolean;
}

/** The middleware matcher, read from middleware.ts rather than restated. */
function matcher(): RegExp {
  const hit = /matcher:\s*\[\s*"((?:[^"\\]|\\.)*)"/.exec(source("middleware.ts"));
  if (!hit) throw new Error("could not read the matcher out of middleware.ts");
  return new RegExp("^" + hit[1].replace(/\\\\/g, "\\") + "$");
}

/* ══════════════ 1. the precache list, which rejects atomically ═══════════ */

describe("the service worker's precache list", () => {
  it("parses, and still names the entries the offline layer is built from", () => {
    const urls = shellUrls();
    // Guards the parser itself: a regex that silently matched nothing would
    // make every loop below vacuous and this file would pass forever.
    expect(urls.length, "parsed no precache URLs out of public/sw.js").toBeGreaterThanOrEqual(6);
    expect(urls, "the /offline fallback is what the SW serves a failed navigation").toContain(
      "/offline"
    );
    expect(
      urls,
      "without the manifest cached, a returning user is never offered install"
    ).toContain("/manifest.json");
    // The two raster sizes Chrome requires before it will offer installation.
    expect(urls).toContain("/android-chrome-192x192.png");
    expect(urls).toContain("/android-chrome-512x512.png");
  });

  const urls = shellUrls();

  for (const url of urls) {
    describe(url, () => {
      it("is served by something, so cache.addAll does not reject on it", () => {
        expect(
          claimants(url),
          "nothing in public/ or app/ serves " +
            url +
            ", so it answers 404 — and cache.addAll rejects atomically, so the service worker " +
            "never activates and the whole offline/PWA layer silently does not come up"
        ).not.toEqual([]);
      });

      it("is not claimed twice over", () => {
        // Deliberately an upper bound: the zero case is the test above, so each
        // assertion reports exactly one thing and neither message can be wrong
        // about which it is.
        const found = claimants(url);
        expect(
          found.length,
          "more than one thing claims " +
            url +
            " (" +
            found.join(", ") +
            "). This is the app/icon.svg vs public/icon.svg collision recorded in " +
            "app/layout.tsx: Next answered it with an error page, that non-2xx made " +
            "cache.addAll reject, and the entire PWA layer disappeared with nothing logging"
        ).toBeLessThanOrEqual(1);
      });

      it("is fetchable without a session", async () => {
        // Two layers, and either one is enough: middleware.ts's matcher skips
        // any path containing a dot, and `authorized()` allow-lists the rest.
        // A precached URL that is neither gets a 302 to /login, which is a
        // non-2xx to cache.addAll just like a 404 — and the service worker
        // installs for signed-OUT visitors too, so a session is not available.
        const inspected = matcher().test(url);
        const allowed = inspected ? await anonymousAllowed(url) : true;
        expect(
          allowed,
          url +
            " is inspected by the auth middleware and is not in the public allow-list in " +
            "auth.config.ts, so an anonymous fetch is redirected to /login. cache.addAll " +
            "rejects on that redirect and the service worker never activates."
        ).toBe(true);
      });
    });
  }

  it("still rejects a neighbouring path, so the check above is not vacuous", async () => {
    // A dotless sibling of /offline: matched by the middleware, absent from the
    // allow-list. If this ever returns true the allow-list has gone fail-open
    // and the assertion above proves nothing.
    expect(matcher().test("/offline-fallback")).toBe(true);
    await expect(anonymousAllowed("/offline-fallback")).resolves.toBe(false);
  });
});

/* ════════════════════════ 2. the web app manifest ═══════════════════════ */

const EXTENSION_FOR_TYPE: Record<string, string[]> = {
  "image/png": [".png"],
  "image/svg+xml": [".svg"],
  "image/webp": [".webp"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/x-icon": [".ico"],
  "image/vnd.microsoft.icon": [".ico"],
};

/** Width/height out of a PNG's IHDR chunk. */
function pngSize(absPath: string): { width: number; height: number } {
  const buf = readFileSync(absPath);
  const signature = buf.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") {
    throw new Error(absPath + " is not a PNG (signature " + signature + ")");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("public/manifest.json", () => {
  const icons = manifest().icons || [];

  it("declares icons at all", () => {
    expect(icons.length, "no icons: Chrome will not offer installation").toBeGreaterThan(0);
  });

  for (const icon of icons) {
    describe(icon.src, () => {
      it("points at a file that exists, claimed by exactly one place", () => {
        const found = claimants(icon.src);
        expect(
          found,
          "manifest.json names " +
            icon.src +
            " and nothing serves it. Chrome drops an unfetchable icon silently — and this file " +
            "is itself precached alongside its icons, so the 404 also rejects cache.addAll"
        ).not.toEqual([]);
        expect(found.length, "two things claim " + icon.src + ": " + found.join(", ")).toBe(1);
      });

      it("declares a type that matches the file it points at", () => {
        if (!icon.type) return;
        const allowed = EXTENSION_FOR_TYPE[icon.type];
        expect(allowed, "unknown icon type " + icon.type + " in manifest.json").toBeTruthy();
        const matches = (allowed || []).some(function (ext) {
          return icon.src.slice(-ext.length).toLowerCase() === ext;
        });
        expect(
          matches,
          icon.src +
            ' is declared as "' +
            icon.type +
            '". Chrome filters the icon list by the declared type before it fetches anything, ' +
            "so a mismatch removes the icon from consideration without any error"
        ).toBe(true);
      });

      it("declares the size the file actually is", () => {
        if (icon.src.slice(-4).toLowerCase() !== ".png") return;
        const abs = join(ROOT, "public", icon.src.replace(/^\//, ""));
        // A missing file is the test above's finding, not this one's: reading it
        // here would just report an ENOENT twice over in different words.
        if (!isFile(abs)) return;
        const real = pngSize(abs);
        expect(
          icon.sizes,
          icon.src +
            " is " +
            real.width +
            "x" +
            real.height +
            " on disk but the manifest says " +
            icon.sizes +
            ". Chrome picks by the DECLARED size, so a lie here is how the install prompt " +
            "goes away without a word: the 192 slot it needs is filled by a file that is not 192"
        ).toBe(real.width + "x" + real.height);
      });
    });
  }

  it("covers the two raster sizes Chrome requires for installability", () => {
    const raster = icons.filter(function (i) {
      return i.src.slice(-4).toLowerCase() === ".png";
    });
    const sizes = raster.map(function (i) {
      return i.sizes;
    });
    expect(sizes, "no 192x192 PNG: Chrome will not offer installation").toContain("192x192");
    expect(sizes, "no 512x512 PNG: Chrome will not offer installation").toContain("512x512");
  });

  it("keeps the SVG entries at a concrete size rather than `any`", () => {
    // Recorded in app/layout.tsx, because manifest.json cannot carry a comment:
    // both SVGs are base64 PNGs inside an <svg> wrapper, not traced vectors, so
    // `"any"` would promise resolution independence the asset does not have and
    // invite Chrome to upscale a raster into the install splash screen.
    const svgs = icons.filter(function (i) {
      return i.src.slice(-4).toLowerCase() === ".svg";
    });
    for (const svg of svgs) {
      expect(svg.sizes, svg.src + ' must declare a concrete size, not "any"').not.toBe("any");
    }
  });

  it("opens on a route that exists", () => {
    const start = manifest().start_url;
    expect(start, "manifest.json has no start_url").toBeTruthy();
    expect(
      appRoutes(),
      "the installed app launches straight into " +
        start +
        ", which no page serves — the home-screen icon opens a 404"
    ).toContain(start as string);
  });
});

/* ═══════════ 3. the asset URLs the root layout names by string ══════════ */

describe("app/layout.tsx asset metadata", () => {
  /** Quoted absolute asset URLs anywhere in the root layout. */
  function layoutAssetUrls(): string[] {
    const src = source("app/layout.tsx");
    const found: string[] = [];
    const pattern = /["'](\/[A-Za-z0-9._/-]*\.(?:svg|png|ico|jpe?g|webp|json))["']/g;
    let m = pattern.exec(src);
    while (m) {
      if (found.indexOf(m[1]) === -1) found.push(m[1]);
      m = pattern.exec(src);
    }
    return found;
  }

  it("names at least the manifest and the icons", () => {
    const urls = layoutAssetUrls();
    expect(urls.length, "parsed no asset URLs out of app/layout.tsx").toBeGreaterThanOrEqual(4);
    expect(urls).toContain("/manifest.json");
    expect(urls).toContain("/apple-touch-icon.png");
  });

  for (const url of layoutAssetUrls()) {
    it(url + " resolves to exactly one file", () => {
      // /apple-touch-icon.png is named ONLY here — nothing else in the repo
      // references it, so a rename of the file in public/ leaves iOS
      // home-screen installs with a blank icon and no other test notices.
      const found = claimants(url);
      expect(found, "app/layout.tsx names " + url + " and nothing serves it").not.toEqual([]);
      expect(found.length, "two things claim " + url + ": " + found.join(", ")).toBe(1);
    });
  }
});
