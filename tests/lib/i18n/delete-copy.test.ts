/**
 * acct-011 — what the delete confirmations promise, against what the code does.
 *
 * THE DEFECT. Every destructive surface in Settings said the operation could not
 * be undone: `dangerZoneNote` was "Irreversible operations… there is no undo",
 * `deleteAccountConfirmDesc` was "This is permanent", `deleteAccountDesc` said
 * "Permanently remove your user record", `deleteWorkspaceDesc` ended "Not
 * reversible." None of that is what happens. `deleteAccountAction` and
 * `deleteWorkspaceAction` write a `deletedAt` tombstone (lib/actions/account.ts),
 * the purge cron keeps tombstoned rows for `RETENTION_DAYS = 90`, and the purge
 * is DRY-RUN unless `PURGE_ENABLED === "true"` — which it is not — so today
 * nothing is erased at all.
 *
 * So the one customer who most needs to know there is a window is the one told,
 * in bold, that there is nothing to ask for. Support cannot restore for someone
 * who never writes in.
 *
 * WHY THIS ASSERTS ABSENCE AS WELL AS PRESENCE. Same reason as
 * tests/lib/i18n/settings-copy.test.ts, which covers the sibling findings
 * acct-007 and acct-002: the defect is not a missing string, it is a present,
 * confident, wrong one. A test that only checked the new sentence exists would
 * stay green with "This is permanent." left sitting beside it. Each claim that
 * must NOT be there is named below, in BOTH locales — a mistranslation that
 * keeps the old promise in Urdu is the identical bug for the Urdu reader.
 *
 * WHY THE NUMBER IS PARSED, NOT TYPED. "90 days" in customer-facing copy is a
 * PROMISE. A promise of 90 over a cron that purges at 30 is the worst possible
 * drift — the customer waits out a deadline that has already passed — so the
 * number in the copy is held against the number in
 * app/api/cron/purge-soft-deleted/route.ts, which is the only authority for it.
 *
 * That also settles the third surface without touching it. The security-notice
 * emails (lib/email/templates/security-notice.ts, acct-005) promise the same
 * window, and their own guard pins `SECURITY_NOTICE_RETENTION_DAYS` to the same
 * `RETENTION_DAYS`. Copy → route and email → route means copy ≡ email, with no
 * test here reaching into a file this slice does not own.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { en, ur } from "@/lib/i18n/strings";

const PURGE_ROUTE = join(process.cwd(), "app", "api", "cron", "purge-soft-deleted", "route.ts");

/** The retention window the cron actually enforces. */
function retentionDaysFromCron(): number {
  const source = readFileSync(PURGE_ROUTE, "utf8");
  const match = source.match(/const\s+RETENTION_DAYS\s*=\s*(\d+)/);
  expect(
    match,
    "app/api/cron/purge-soft-deleted/route.ts no longer declares `const RETENTION_DAYS = <n>`. " +
      "The customer-facing window is derived from it; find where it moved rather than typing a number here."
  ).toBeTruthy();
  return Number(match?.[1]);
}

type Surface = { key: string; english: string; urdu: string };

/**
 * The four surfaces a customer reads at the moment of deciding: the section
 * note that is always on screen, and the three confirmation dialogs. These are
 * where the window and the remedy have to appear.
 */
const DECISION_SURFACES: Surface[] = [
  {
    key: "dangerZoneNote",
    english: en.settings.dangerZoneNote,
    urdu: ur.settings.dangerZoneNote,
  },
  {
    key: "deleteAccountConfirmDesc",
    english: en.settings.deleteAccountConfirmDesc,
    urdu: ur.settings.deleteAccountConfirmDesc,
  },
  {
    key: "deleteAccountWorkspaceConfirmDesc",
    english: en.settings.deleteAccountWorkspaceConfirmDesc,
    urdu: ur.settings.deleteAccountWorkspaceConfirmDesc,
  },
  {
    key: "deleteWorkspaceConfirmDesc",
    english: en.settings.deleteWorkspaceConfirmDesc,
    urdu: ur.settings.deleteWorkspaceConfirmDesc,
  },
];

/** Every string that describes a delete, decision surfaces plus button blurbs. */
const ALL_DELETE_COPY: Surface[] = DECISION_SURFACES.concat([
  {
    key: "deleteAccountDesc",
    english: en.settings.deleteAccountDesc,
    urdu: ur.settings.deleteAccountDesc,
  },
  {
    key: "deleteWorkspaceDesc",
    english: en.settings.deleteWorkspaceDesc,
    urdu: ur.settings.deleteWorkspaceDesc,
  },
]);

describe("no delete surface claims the delete is irreversible (acct-011)", () => {
  it("drops 'there is no undo' from the danger-zone note", () => {
    expect(
      en.settings.dangerZoneNote,
      "deleteAccountAction and deleteWorkspaceAction write a tombstone; the rows are still there."
    ).not.toMatch(/no undo|irreversible|cannot be undone/i);
    // The Urdu carried the same promise: "واپس نہیں کیا جا سکتا" (cannot be
    // undone) after "ناقابلِ واپسی کارروائیاں" (irreversible operations).
    expect(ur.settings.dangerZoneNote).not.toContain("واپس نہیں کیا جا سکتا");
    expect(ur.settings.dangerZoneNote).not.toContain("ناقابلِ واپسی");
  });

  it("drops 'This is permanent' from the account-delete confirmation", () => {
    expect(en.settings.deleteAccountConfirmDesc).not.toMatch(/permanent/i);
    // "یہ عمل مستقل ہے" — "this action is permanent".
    expect(ur.settings.deleteAccountConfirmDesc).not.toContain("مستقل");
  });

  it("drops 'Not reversible' from the workspace-delete description", () => {
    expect(en.settings.deleteWorkspaceDesc).not.toMatch(/not reversible|irreversible|permanent/i);
    // "واپس نہیں ہو گا" — "it will not come back".
    expect(ur.settings.deleteWorkspaceDesc).not.toContain("واپس نہیں ہو گا");
  });

  it("drops 'Permanently remove' from the account-delete description", () => {
    expect(en.settings.deleteAccountDesc).not.toMatch(/permanent/i);
    // "مستقل ختم ہو جائیں گی" — "will be permanently finished".
    expect(ur.settings.deleteAccountDesc).not.toContain("مستقل");
  });

  it("leaves no 'permanent' or 'irreversible' claim anywhere in the delete copy", () => {
    ALL_DELETE_COPY.forEach(({ key, english, urdu }) => {
      expect(english, `en.settings.${key}`).not.toMatch(
        /permanent|irreversible|no undo|not reversible|cannot be undone|gone for good/i
      );
      expect(urdu, `ur.settings.${key}`).not.toContain("مستقل");
      expect(urdu, `ur.settings.${key}`).not.toContain("ناقابلِ واپسی");
    });
  });
});

describe("every decision surface names the window and the way to use it", () => {
  const days = retentionDaysFromCron();

  it("matches the window the purge cron enforces, in both locales", () => {
    // Latin digits in Urdu are the pinned decision — lib/i18n/numbering.ts
    // argues it at length (a figure a founder cannot paste into a bank portal
    // is a broken figure), so "90" is correct copy in `ur`, not an oversight.
    DECISION_SURFACES.forEach(({ key, english, urdu }) => {
      expect(english, `en.settings.${key} must name the ${days}-day window`).toContain(
        String(days)
      );
      expect(urdu, `ur.settings.${key} must name the ${days}-day window`).toContain(String(days));
    });
  });

  it("tells the customer who to contact, in both locales", () => {
    // A window nobody is told how to use is the same as no window: recovery is
    // a manual SQL UPDATE by an operator (CLAUDE.md documents it), not a
    // self-service button, so the copy has to point at a human.
    DECISION_SURFACES.forEach(({ key, english, urdu }) => {
      expect(english, `en.settings.${key} must say how to reach support`).toMatch(/support/i);
      expect(urdu, `ur.settings.${key} must say how to reach support`).toContain("سپورٹ");
    });
  });

  it("still says access ends immediately, which IS true", () => {
    // The fix must not overcorrect into "nothing really happens". Auth and every
    // scoped query filter `deletedAt: null`, so the session dies on the next
    // request and the workspace is unreachable from that moment.
    expect(en.settings.dangerZoneNote).toMatch(/immediat/i);
    expect(en.settings.deleteAccountConfirmDesc).toMatch(/immediat/i);
    expect(en.settings.deleteWorkspaceConfirmDesc).toMatch(/immediat/i);
    expect(ur.settings.dangerZoneNote).toContain("فوراً");
    expect(ur.settings.deleteAccountConfirmDesc).toContain("فوراً");
    expect(ur.settings.deleteWorkspaceConfirmDesc).toContain("فوراً");
  });

  it("promises no deadline the dry-run cron cannot keep", () => {
    // `PURGE_ENABLED` is unset, so rows outlive the window today. The copy
    // therefore states the window as a FLOOR ("we keep a recoverable copy for
    // 90 days") and makes no claim about what happens on day 91 — which is the
    // one sentence whose truth depends on an env var. The security-notice
    // email, sent at the real deletedAt and read at the START of the clock,
    // carries the concrete date; a modal read BEFORE the click does not need it
    // and cannot compute the same instant the email will.
    DECISION_SURFACES.forEach(({ key, english }) => {
      expect(english, `en.settings.${key}`).not.toMatch(
        /after that|then it'?s gone|deleted for ever|deleted forever/i
      );
    });
  });
});
