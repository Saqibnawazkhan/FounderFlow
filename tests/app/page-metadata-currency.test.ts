/**
 * No in-app page's metadata names ONE currency (R6-docs).
 *
 * `Company.currency` is a per-workspace setting — one of `SUPPORTED_CURRENCIES`,
 * chosen at signup — and every figure on these screens is rendered through
 * `formatCurrency(amount, company.currency)` so it follows that choice. The prose
 * around the figures has to follow it too, and a `Metadata.description` is prose
 * that travels: it is the page's `<meta name="description">`, so it is what a
 * bookmark, a search result and a pasted link preview say about the screen.
 *
 * /expenses shipped `description: "Track every PKR going out of your company…"`,
 * so a USD workspace's own expenses page advertised a currency it does not use
 * while the table under it rendered dollars. Every other page in `app/(app)` was
 * already neutral, which is why this is a sweep and not a single assertion — the
 * next copy of the mistake will be on a different page.
 *
 * The code list is READ FROM `SUPPORTED_CURRENCIES` rather than written out here,
 * so a seventh currency is covered the day it is added rather than the day
 * somebody remembers this file. The spelled-out names are a short hand-written
 * list because "Track every rupee" is the same defect with no ISO code in it.
 *
 * Scoped to `app/(app)` deliberately: the marketing copy on /login and /signup
 * quotes PKR figures on purpose (FounderFlow is Pakistan-first and those pages
 * belong to no workspace), while everything under `app/(app)` is rendered inside
 * one workspace whose currency is known.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SUPPORTED_CURRENCIES } from "@/lib/schemas/company";

const ROOT = process.cwd();
const IN_APP = join(ROOT, "app", "(app)");

function pageFiles(dir: string): string[] {
  const found: string[] = [];
  const entries = readdirSync(dir);
  for (let i = 0; i < entries.length; i++) {
    const full = join(dir, entries[i]);
    if (statSync(full).isDirectory()) {
      const inner = pageFiles(full);
      for (let j = 0; j < inner.length; j++) found.push(inner[j]);
    } else if (entries[i] === "page.tsx") {
      found.push(full);
    }
  }
  return found;
}

/**
 * Every `description:` string literal in a page module — the static
 * `export const metadata` form and the `generateMetadata()` form alike, including
 * the `channel.topic ?? "…"` fallback in chat/[slug].
 *
 * `[^"]` crosses newlines (dashboard's description sits on its own line) but
 * stops at the first quote, so the capture is the literal that follows the key
 * and nothing further down the file.
 */
function descriptions(source: string): string[] {
  const out: string[] = [];
  const re = /description:[^"]{0,80}"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    out.push(m[1]);
    m = re.exec(source);
  }
  return out;
}

const CURRENCY_NAMES = /\b(rupees?|dollars?|euros?|pounds?|dirhams?|paisa|cents?)\b/i;

describe("in-app page metadata is currency-neutral", () => {
  const pages = pageFiles(IN_APP);

  it("finds the pages at all, or the sweep below proves nothing", () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  it("names no ISO currency code in any page description", () => {
    for (let i = 0; i < pages.length; i++) {
      const where = relative(ROOT, pages[i]);
      const found = descriptions(readFileSync(pages[i], "utf8"));
      for (let d = 0; d < found.length; d++) {
        for (let c = 0; c < SUPPORTED_CURRENCIES.length; c++) {
          const code = SUPPORTED_CURRENCIES[c];
          expect(
            new RegExp(`\\b${code}\\b`).test(found[d]),
            `${where} describes itself in ${code}: "${found[d]}" — the workspace picks its own currency`
          ).toBe(false);
        }
      }
    }
  });

  it("names no currency in words either", () => {
    for (let i = 0; i < pages.length; i++) {
      const where = relative(ROOT, pages[i]);
      const found = descriptions(readFileSync(pages[i], "utf8"));
      for (let d = 0; d < found.length; d++) {
        const hit = CURRENCY_NAMES.exec(found[d]);
        expect(
          hit === null,
          `${where} describes itself in ${hit ? hit[0] : ""}: "${found[d]}"`
        ).toBe(true);
      }
    }
  });
});
