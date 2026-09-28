/**
 * prodready-005 — what happens when production has no mail transport.
 *
 * THE FINDING, in the user's words: "a production deploy that forgets the Gmail
 * credentials still tells a locked-out customer 'check your email', sends
 * nothing, raises no alert, and prints the live password-reset link into the
 * server log instead."
 *
 * The build gate in `scripts/vercel-build.mjs` now refuses such a deploy, and
 * that is the main fix. This file covers the two things the build gate cannot:
 *
 *   1. NOBODY IS TOLD. `getTransporter()` returning null is the one branch in
 *      this file that reports nothing — not a console.error, not Sentry. Every
 *      other failure path here calls captureServerError. Password reset is the
 *      only self-service recovery path in the product (there is no admin "reset
 *      this user's password" control), so the branch where mail silently stops
 *      is the one that most needs an alert.
 *
 *   2. THE BODY GOES INTO THE LOG. The log line contains `html=${html}`, which
 *      for a reset is the live one-time reset URL and for an invite is the live
 *      invite URL. Vercel function logs are readable by every team member and by
 *      any configured log drain.
 *
 * THE COUNTER-ARGUMENT IN THE SOURCE, which is half right and is why the fix is
 * conditional rather than a deletion: the comment in `send.ts` says the body is
 * not a leak, because this branch is only reached when no mail is being sent to
 * anyone at all, so the only content printed is content that had no other way of
 * reaching its recipient. That is exactly true IN DEVELOPMENT — it is how you
 * click the reset link on localhost — and the dev stub must keep working. It is
 * false in production, where nobody is reading function logs to hand-deliver a
 * stranger's reset link, and the log is shared. So: keep the body in dev, drop
 * it in production, and alert in production.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describeUnconfiguredSend } from "@/lib/email/send";

const RESET_HTML =
  '<p>Reset it: <a href="https://app.founderflow.com/reset-password?token=' +
  'a7f3c9d1e5b84206bc31f0e9d7a2c845">click here</a></p>';

const CTX = {
  to: "founder@example.com",
  subject: "Reset your FounderFlow password",
  text: "Reset it: https://app.founderflow.com/reset-password?token=a7f3c9d1e5b84206bc31f0e9d7a2c845",
  html: RESET_HTML,
  from: "FounderFlow <noreply@founderflow.com>",
};

describe("no mail transport in production", () => {
  it("does not print the live reset link into the server log", () => {
    const outcome = describeUnconfiguredSend({ ...CTX, isProduction: true });
    const logged = outcome.lines.join("\n");
    expect(
      logged,
      "the full HTML body — containing a live one-time password-reset token — is written " +
        "to the production log, where every team member and every log drain can read it"
    ).not.toContain("token=a7f3c9d1e5b84206bc31f0e9d7a2c845");
    expect(logged, "the raw html body is in the production log").not.toContain(RESET_HTML);
    expect(
      logged,
      "the plain-text alternative carries the same live link and is also in the log"
    ).not.toContain(CTX.text);

    // Triage still needs to know that a send was dropped, and for whom.
    expect(logged, "the log line no longer says who the mail was for").toContain(CTX.to);
    expect(logged.toLowerCase()).toContain("gmail_user");
  });

  it("reports to Sentry, because silence here is the whole bug", () => {
    const outcome = describeUnconfiguredSend({ ...CTX, isProduction: true });
    expect(
      outcome.report,
      "a production deploy with no mail transport drops every invite and every password " +
        "reset and tells nobody. This is the only branch in send.ts that reports nothing."
    ).toBe(true);
  });

  it("returns a result a caller can tell apart from a successful send", () => {
    const outcome = describeUnconfiguredSend({ ...CTX, isProduction: true });
    expect(outcome.result.delivered, "an unsent email must never report delivered").toBe(false);
    expect(
      outcome.result.error,
      "the result carries no error, so /forgot-password cannot distinguish 'sent' from " +
        "'there is no mail transport' and shows the success state either way"
    ).toBeTruthy();
    expect(
      outcome.result.devLogged,
      "devLogged promises the caller the message body is in the log so it can be shared " +
        "by hand. In production it is deliberately not, so claiming it is misleads the " +
        "one caller that might act on it."
    ).toBe(false);
  });
});

describe("no mail transport in development (the dev stub must keep working)", () => {
  it("still prints the whole message, including the link you need to click", () => {
    const outcome = describeUnconfiguredSend({ ...CTX, isProduction: false });
    const logged = outcome.lines.join("\n");
    expect(
      logged,
      "the local dev flow is: no Gmail credentials, trigger a reset, copy the link out of " +
        "the terminal. Hardening the body out of the dev branch too would break that."
    ).toContain("token=a7f3c9d1e5b84206bc31f0e9d7a2c845");
    expect(logged).toContain(RESET_HTML);
    expect(logged).toContain(CTX.from);
  });

  it("does not page anyone about a laptop with no SMTP credentials", () => {
    const outcome = describeUnconfiguredSend({ ...CTX, isProduction: false });
    expect(
      outcome.report,
      "every dev without Gmail credentials would raise a Sentry event per email; the " +
        "alert would be noise and would get muted, taking the production signal with it"
    ).toBe(false);
    expect(outcome.result.devLogged, "the dev stub did log the message for the developer").toBe(
      true
    );
  });
});

describe("the wiring (a decision nothing calls is not a fix)", () => {
  const src = readFileSync(join(process.cwd(), "lib/email/send.ts"), "utf8");

  it("sendEmail routes its no-transport branch through that decision", () => {
    expect(
      src.indexOf("describeUnconfiguredSend("),
      "describeUnconfiguredSend is exported and tested but sendEmail does not use it"
    ).toBeGreaterThan(-1);
    // The old branch inlined the body into a template literal inside sendEmail
    // itself. If that spelling comes back there, the production redaction is
    // bypassed no matter what describeUnconfiguredSend decides. (Inside
    // describeUnconfiguredSend it is correct — that is the dev stub.)
    const sendEmailBody = src.slice(src.indexOf("export async function sendEmail"));
    expect(sendEmailBody.length, "sendEmail is gone from lib/email/send.ts").toBeGreaterThan(0);
    expect(
      /html=\$\{html\}/.test(sendEmailBody),
      "the raw `html=${html}` interpolation is back inside sendEmail, so the production " +
        "log carries live reset links again regardless of what describeUnconfiguredSend says"
    ).toBe(false);
  });

  it("actually calls captureServerError when the decision says to report", () => {
    const branch = src.slice(src.indexOf("describeUnconfiguredSend("));
    expect(
      /captureServerError\(/.test(branch),
      "nothing calls captureServerError after the no-transport decision, so `report: true` " +
        "is a value nobody acts on"
    ).toBe(true);
  });

  it("decides production from the deployment, not only from NODE_ENV", () => {
    // `next build` sets NODE_ENV=production for preview deploys too. Keying only
    // off it would redact bodies on previews (harmless) but would also raise a
    // Sentry event for every preview deploy that has no Gmail credentials, which
    // previews legitimately do not — and that noise is what mutes the alert.
    expect(
      /VERCEL_ENV/.test(src),
      "send.ts decides 'is this production' without looking at VERCEL_ENV, so preview " +
        "deploys are treated as production"
    ).toBe(true);
  });
});
