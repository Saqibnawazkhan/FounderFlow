// @vitest-environment node

/**
 * auth-016 — a customer's own name must not be able to break the HTML of a
 * transactional email.
 *
 * NODE ENVIRONMENT, ON PURPOSE. Two of the three flows below mint a real HS256
 * token, and jsdom's `TextEncoder` hands `jose` a `Uint8Array` from a foreign
 * realm, which it rejects with the self-contradictory "Received an instance of
 * Uint8Array". Nothing here renders a component.
 *
 * WHAT IS BEING DEFENDED, STATED HONESTLY. These are HTML emails addressed to
 * the account's OWN inbox, so the realistic outcome of an unescaped name is a
 * mangled email and, at worst, a self-inflicted injection into a message only
 * the author receives — not a cross-account attack. `User.name` is validated as
 * `z.string().trim().min(1).max(80)` with no character class, so it is
 * arbitrary text, and `escapeHtml` was already applied in the three files under
 * lib/email/templates/ and in NONE of the three named here. The value of fixing
 * it is that "escape at the boundary" is either the rule everywhere or it is not
 * the rule at all: the next template to interpolate a value is as likely to
 * carry a company name into a message sent to someone else.
 *
 * WHY THE PLAIN-TEXT ASSERTIONS ARE HERE TOO. The cheap fix is to escape the
 * whole body, which puts `&amp;` and `&#39;` in front of a human reading the
 * text/plain alternative. So every case below also pins that no HTML entity
 * reaches the text part — and the two that greet by name there pin that the name
 * is byte-for-byte what the customer typed. (The other three text bodies carry
 * no name at all: they are a subject line, a sentence and a URL.)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import bcrypt from "bcryptjs";

/**
 * `vi.mock` factories are hoisted above the imports, so the recorder they close
 * over has to be built in `vi.hoisted` — the same note as
 * tests/lib/actions/email-change.test.ts.
 */
const H = vi.hoisted(() => {
  const sent: Array<{ to: string; subject: string; html: string; text?: string }> = [];
  type Row = {
    id: string;
    name: string;
    email: string;
    passwordHash: string;
    sessionVersion: number;
    deletedAt: Date | null;
  };
  const state = { rows: [] as Row[], session: null as unknown };

  const serve = async (args?: Record<string, unknown>) => {
    const where = ((args ?? {}).where ?? {}) as Record<string, unknown>;
    return (
      state.rows.find((r) => {
        if ("deletedAt" in where && where.deletedAt === null && r.deletedAt !== null) return false;
        if (typeof where.email === "string" && where.email !== r.email) return false;
        if (typeof where.id === "string" && where.id !== r.id) return false;
        return true;
      }) ?? null
    );
  };

  return {
    sent,
    state,
    db: {
      user: {
        findFirst: serve,
        findUnique: serve,
        update: async () => ({}),
      },
    },
  };
});

vi.mock("@/lib/db", () => ({ db: H.db }));
vi.mock("@/lib/auth", () => ({ auth: async () => H.state.session }));
vi.mock("@/lib/client-ip", () => ({ getClientIp: async () => "203.0.113.9" }));
vi.mock("@/lib/sentry-server", () => ({ captureServerError: vi.fn() }));
// Spread the real module so a NEW export cannot silently break this file — a
// factory mock REPLACES the module, and an omitted export is simply absent.
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  gateAuthAction: () => ({ allowed: true }),
}));
vi.mock("@/lib/email/send", () => ({
  sendEmail: async (input: { to: string; subject: string; html: string; text?: string }) => {
    H.sent.push(input);
    return { delivered: true, devLogged: false };
  },
}));

import { requestEmailChangeAction, confirmEmailChangeAction } from "@/lib/actions/email-change";
import { requestPasswordResetAction } from "@/lib/actions/password-reset";
import { sendVerificationEmail } from "@/lib/email/verification";
import { emailChangeBinding, signEmailChangeToken } from "@/lib/auth/email-change-token";

/* ─────────────────────────────────────────────────────────────────────────── */

const PASSWORD = "correct-horse-battery";
/** Work factor 4, not 12 — this hashes on every test and never ships. */
const HASH = bcrypt.hashSync(PASSWORD, 4);

const OLD_EMAIL = "founder@nimbus.app";
const NEW_EMAIL = "founder@newdomain.com";

/**
 * One name carrying every character that matters: the tag that closes the
 * surrounding element, the quote that escapes an attribute, the ampersand that
 * mangles the entity of whatever follows it.
 */
const POISON_NAME = 'Ada <script>alert("x")</script> O\'Brien & Co';

function row(over: Partial<(typeof H.state.rows)[number]> = {}) {
  return {
    id: "u1",
    name: POISON_NAME,
    email: OLD_EMAIL,
    passwordHash: HASH,
    sessionVersion: 0,
    deletedAt: null,
    ...over,
  };
}

/** Entities that belong in HTML and are a defect in a text/plain alternative. */
const ENTITIES = ["&lt;", "&gt;", "&amp;", "&quot;", "&#39;"];

/**
 * The contract, in one place: the HTML body carries the name as text and not as
 * markup, and the text/plain body is not escaped at all.
 */
function expectNameIsTextNotMarkup(mail: { html: string; text?: string }, where: string) {
  expect(mail.html, `${where}: the raw <script> tag reached the HTML body`).not.toContain(
    "<script>"
  );
  expect(mail.html, `${where}: the name is not HTML-escaped`).toContain("&lt;script&gt;");
  expect(mail.html, `${where}: the apostrophe is not escaped`).toContain("O&#39;Brien");
  // THE TEXT PART MUST EXIST BEFORE ITS CONTENT IS JUDGED. This used to read
  // `mail.text ?? ""`, and an empty string contains no entity, so a body that
  // shipped without a text/plain alternative satisfied every case below by
  // having nothing to check — a vacuous pass, and the same defect class this
  // file was written to catch. All five bodies carry one today, so the old form
  // was never wrong, only unable to notice if that changed.
  expect(
    typeof mail.text,
    `${where}: no text/plain alternative, so the entity checks below would pass by being empty`
  ).toBe("string");
  expect((mail.text ?? "").length, `${where}: the text/plain alternative is empty`).toBeGreaterThan(
    0
  );
  ENTITIES.forEach((entity) => {
    expect(
      mail.text ?? "",
      `${where}: the text/plain part contains the HTML entity ${entity}, which a human reads literally`
    ).not.toContain(entity);
  });
}

/** For the two bodies whose text/plain part greets the customer by name. */
function expectNameVerbatimInText(mail: { text?: string }, where: string) {
  expect(mail.text, `${where}: the text/plain part must show the name verbatim`).toContain(
    POISON_NAME
  );
}

beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret-for-transactional-escaping";
  H.sent.length = 0;
  H.state.rows = [];
  H.state.session = null;
});

describe("auth-016 — a customer's name in a transactional email", () => {
  it("is escaped in the signup / resend verification email (lib/email/verification.ts)", async () => {
    await sendVerificationEmail({ userId: "u1", name: POISON_NAME, email: OLD_EMAIL });

    expect(H.sent).toHaveLength(1);
    expectNameIsTextNotMarkup(H.sent[0], "verification email");
  });

  it("is escaped in the password-reset email (lib/actions/password-reset.ts)", async () => {
    H.state.rows = [row()];

    await requestPasswordResetAction({ email: OLD_EMAIL });

    const mail = H.sent.find((m) => m.to === OLD_EMAIL);
    expect(mail, "no reset email was dispatched").toBeDefined();
    expectNameIsTextNotMarkup(mail!, "password-reset email");
  });

  it("is escaped in the confirm-your-new-email email (lib/actions/email-change.ts)", async () => {
    H.state.rows = [row()];
    H.state.session = { user: { id: "u1", companyId: "c1", role: "admin" } };

    const res = await requestEmailChangeAction({ newEmail: NEW_EMAIL, password: PASSWORD });
    expect(res.success, `the request failed: ${JSON.stringify(res)}`).toBe(true);

    const mail = H.sent.find((m) => m.to === NEW_EMAIL);
    expect(mail, "no confirmation email was dispatched").toBeDefined();
    expectNameIsTextNotMarkup(mail!, "email-change confirmation");
  });

  it("is escaped in the heads-up sent to the address being replaced", async () => {
    H.state.rows = [row()];
    H.state.session = { user: { id: "u1", companyId: "c1", role: "admin" } };

    await requestEmailChangeAction({ newEmail: NEW_EMAIL, password: PASSWORD });

    const mail = H.sent.find((m) => m.to === OLD_EMAIL);
    expect(mail, "the old address was not warned").toBeDefined();
    expectNameIsTextNotMarkup(mail!, "email-change warning (request)");
    expectNameVerbatimInText(mail!, "email-change warning (request)");
  });

  it("is escaped in the it-has-landed notice after the change is confirmed", async () => {
    const r = row();
    H.state.rows = [r];
    const token = await signEmailChangeToken("u1", NEW_EMAIL, emailChangeBinding(r));

    const res = await confirmEmailChangeAction({ token });
    expect(res.success, `the confirm failed: ${JSON.stringify(res)}`).toBe(true);

    const mail = H.sent.find((m) => m.to === OLD_EMAIL);
    expect(mail, "the old address was not told the change landed").toBeDefined();
    expectNameIsTextNotMarkup(mail!, "email-change warning (applied)");
    expectNameVerbatimInText(mail!, "email-change warning (applied)");
  });
});
