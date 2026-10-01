import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NOTIFY_EVENTS } from "@/lib/notify/fan-out";
import { EVENT_DELIVERABLE_CHANNELS } from "@/lib/notify/events";
import { stripComments } from "../harness/source-scan";

/**
 * Structural guards over the notification fan-out.
 *
 * FaultsAudit S9 (notification preferences) sat deferred for months with the
 * reasoning that a preference has to be *enforced*, and enforcing it across
 * ten hand-rolled `notification.create` call sites was not worth the risk of
 * missing one. These tests are what make that safe: they fail if anyone
 * reintroduces a direct write, or invents an event name the preferences UI
 * will not know about.
 *
 * All three walk the directory tree rather than checking a hardcoded file
 * list — a list stops covering whatever is added next week, which is exactly
 * the failure mode being guarded against.
 *
 * They walk `app/` as well as `lib/`. Scanning only `lib/` left the guard
 * with a hole the size of the App Router: a `"use server"` module or a route
 * handler under `app/` can reach Prisma exactly as well as anything in
 * `lib/`, and a direct `notification.create` there would have passed a green
 * suite. `.tsx` counts too — "use server" is legal in one, so the extension
 * is no protection.
 */

const ROOTS = [join(process.cwd(), "lib"), join(process.cwd(), "app")];

/** Every .ts/.tsx source file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Every scanned source file, across every root. */
function scanned(): string[] {
  return ROOTS.flatMap(sourceFiles);
}

function rel(path: string) {
  return path.slice(process.cwd().length + 1).replace(/\\/g, "/");
}

// The one file allowed to know how a notification row is written:
//   lib/notify/fan-out.ts — the helper itself
//
// lib/db.ts used to be exempt too, for the Prisma `$extends` hook that turned
// every notification write into a web-push send. Phase C deleted that hook
// (see the file's own header) and the exemption outlived it. A stale
// exemption is a hole, not a leftover: it is a standing licence for the
// single most convenient file in which to hand-roll a notification write.
const ALLOWED = new Set(["lib/notify/fan-out.ts"]);

describe("notification fan-out (the single write path)", () => {
  it("reaches every root it claims to scan", () => {
    // Guards the guard. Each check below passes vacuously if its input is
    // empty, so a root that is renamed, moved under src/, or simply typo'd
    // would turn all three into tests that cannot fail — silently, and in
    // green. Assert per-root rather than on a total so losing one root
    // cannot hide behind the other's file count.
    const empty = ROOTS.filter((root) => sourceFiles(root).length === 0);
    expect(
      empty.map(rel),
      "These scan roots yielded no source files, so the fan-out guards below " +
        "are inspecting nothing. Fix ROOTS in this file:"
    ).toEqual([]);
  });

  it("no module writes a notification directly — every fan-out goes through notifyUsers", () => {
    const direct = scanned()
      .map((f) => ({ file: rel(f), src: readFileSync(f, "utf8") }))
      .filter(({ file }) => !ALLOWED.has(file))
      .filter(({ src }) => /\.notification\.create(Many)?\s*\(/.test(src))
      .map(({ file }) => file);

    expect(
      direct,
      `These write Notification rows directly. Route them through notifyUsers() ` +
        `in lib/notify/fan-out.ts, or preferences and email will silently skip them:\n` +
        direct.map((f) => `  - ${f}`).join("\n")
    ).toEqual([]);
  });

  it("every notifyUsers call site names a known event", () => {
    const known = new Set<string>(NOTIFY_EVENTS);
    const unknown: string[] = [];

    for (const f of scanned()) {
      const file = rel(f);
      if (file === "lib/notify/fan-out.ts") continue;
      const src = readFileSync(f, "utf8");
      // `event:` is the first property at every call site by convention.
      const found = Array.from(src.matchAll(/notifyUsers\(\{\s*event:\s*"([^"]+)"/g));
      for (const m of found) {
        if (!known.has(m[1]!)) unknown.push(`${file}: "${m[1]}"`);
      }
    }

    expect(
      unknown,
      `Unknown NotifyEvent(s). Add them to NOTIFY_EVENTS so the preferences ` +
        `matrix can offer a switch for them:\n` +
        unknown.map((u) => `  - ${u}`).join("\n")
    ).toEqual([]);
  });

  it("every declared event is actually raised somewhere", () => {
    // A preference switch for an event nothing emits is a lie in the UI.
    const src = scanned()
      .filter((f) => rel(f) !== "lib/notify/fan-out.ts")
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");

    const unused = NOTIFY_EVENTS.filter((e) => !src.includes(`event: "${e}"`));
    expect(unused, `Declared but never raised: ${unused.join(", ")}`).toEqual([]);
  });
});

/**
 * `EVENT_DELIVERABLE_CHANNELS` must describe what the call sites actually do.
 *
 * Chat stopped writing in-app rows (`skipInApp`, lib/notify/fan-out.ts) so that
 * a message announces itself on the sidebar's Chat badge instead of under the
 * bell. That leaves the preferences matrix with a hazard: an "In app" checkbox
 * for direct messages would save happily, read back correctly, and govern
 * nothing. `EVENT_DELIVERABLE_CHANNELS` is what stops the matrix offering it —
 * and a hand-maintained map of which events skip which channel is exactly the
 * kind of thing that is true on the day it is written and quietly false a month
 * later.
 *
 * So it is not trusted. This derives the answer from the call sites themselves:
 * an event whose EVERY site passes `skipInApp: true` cannot deliver in-app, and
 * one with even a single site that does not, can. `mention` is the case that
 * makes the distinction matter — chat skips it, `createCommentAction` does not,
 * so the switch stays honest and must stay offered.
 *
 * Comments are blanked before scanning. This very file, and the fan-out's own
 * doc comment, contain the literal text `skipInApp: true` in prose; without
 * that step the guard would read its own explanation as evidence.
 */
describe("the preferences matrix cannot offer a switch nothing honours", () => {
  /** Every `notifyUsers({ ... })` argument literal in the tree, brace-balanced. */
  function callSites(): Array<{ file: string; event: string; skipsInApp: boolean }> {
    const out: Array<{ file: string; event: string; skipsInApp: boolean }> = [];
    for (const f of scanned()) {
      const file = rel(f);
      if (file === "lib/notify/fan-out.ts") continue;
      const src = stripComments(readFileSync(f, "utf8"));
      let from = 0;
      for (;;) {
        const at = src.indexOf("notifyUsers({", from);
        if (at === -1) break;
        // Walk to the matching close brace so a second call in the same file
        // cannot bleed into this one's body. Strings keep their contents here
        // (the event name IS one), so a `{` inside a string could in principle
        // skew the depth; none of the call sites has one, and the event
        // assertion below would fail loudly rather than silently if that
        // changed.
        let depth = 0;
        let end = at + "notifyUsers(".length;
        for (; end < src.length; end++) {
          if (src[end] === "{") depth++;
          else if (src[end] === "}") {
            depth--;
            if (depth === 0) break;
          }
        }
        const body = src.slice(at, end + 1);
        const event = /event:\s*"([^"]+)"/.exec(body);
        if (event) {
          out.push({
            file,
            event: event[1]!,
            skipsInApp: /skipInApp:\s*true/.test(body),
          });
        }
        from = end + 1;
      }
    }
    return out;
  }

  it("finds the call sites it is about to reason over", () => {
    // Guards the guard twice. An empty list would make every assertion below
    // pass vacuously, and a list with no suppressing site would mean the
    // brace-walk silently stopped finding `skipInApp` — which reads as "the map
    // is correct" rather than "the scan broke".
    const sites = callSites();
    expect(sites.length, "no notifyUsers call sites found — the scan is broken").toBeGreaterThan(7);
    expect(
      sites.filter((s) => s.skipsInApp).length,
      "no call site was seen to skip the in-app row, so this guard is asserting nothing"
    ).toBeGreaterThan(0);
  });

  it("marks in-app undeliverable for exactly the events that always skip it", () => {
    const sites = callSites();
    const wrong: string[] = [];

    for (const event of NOTIFY_EVENTS) {
      const mine = sites.filter((s) => s.event === event);
      if (mine.length === 0) continue; // covered by the "never raised" test above
      const everySiteSkips = mine.every((s) => s.skipsInApp);
      const declared = EVENT_DELIVERABLE_CHANNELS[event].indexOf("inApp") !== -1;
      if (everySiteSkips && declared) {
        wrong.push(
          `"${event}": every call site passes skipInApp, so no row is ever written — ` +
            `remove "inApp" from EVENT_DELIVERABLE_CHANNELS or the settings page offers a dead switch`
        );
      }
      if (!everySiteSkips && !declared) {
        wrong.push(
          `"${event}": ${mine
            .filter((s) => !s.skipsInApp)
            .map((s) => s.file)
            .join(", ")} ` +
            `still writes an in-app row, but the settings page no longer offers the switch for it`
        );
      }
    }

    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("suppresses the in-app row for direct messages and NOTHING else", () => {
    // The scope of the suppression, pinned. It was briefly wider: chat's mention
    // ping skipped its row too, which left a reader whose only enabled channel
    // is in-app with no way to learn they had been named — a badge counts
    // messages and cannot say that one of them was addressed to you. Narrowing
    // it back to DMs is the decision this asserts, in both directions, because
    // either half drifting alone is a silent product change.
    const sites = callSites();
    const skipping = sites.filter((s) => s.skipsInApp);
    expect(
      Array.from(new Set(skipping.map((s) => s.event))),
      "only the dm event may suppress its in-app row"
    ).toEqual(["dm"]);
    expect(
      skipping.length,
      "both DM fan-outs skip: the send path and the runway card"
    ).toBeGreaterThan(1);
  });

  it("keeps the in-app switch on `mention`, in chat as well as in comments", () => {
    const mention = callSites().filter((s) => s.event === "mention");
    expect(mention.length, "expected a chat site and a comments site").toBeGreaterThan(1);
    expect(
      mention.every((s) => !s.skipsInApp),
      "an @mention names a person and must stay in the durable list"
    ).toBe(true);
    expect(EVENT_DELIVERABLE_CHANNELS.mention.indexOf("inApp")).not.toBe(-1);
  });
});
