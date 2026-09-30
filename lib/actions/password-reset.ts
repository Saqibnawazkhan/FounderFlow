"use server";

/**
 * Password-reset server actions.
 *
 * Enumeration posture: `requestPasswordResetAction` returns success even when
 * no account matches the email. That prevents an attacker from probing which
 * addresses are registered by watching for a different error path. The email
 * is only actually sent when a matching user exists.
 *
 * Delivery posture: `sendEmail()` returns `{ delivered, devLogged }`. When
 * SMTP isn't configured (local dev, or a partial prod deploy), the reset
 * link is logged to the server console. The client toast is identical
 * either way so the enumeration guarantee holds.
 *
 * Rate limit: the two halves of this flow are in DIFFERENT risk classes and no
 * longer share a bucket with login or signup (auth-007). Requesting a link is
 * `emailDispatch` — 10 per client address / 10 min and 5 per submitted address
 * / 15 min, because the cost is somebody's inbox and our capped Gmail quota.
 * Redeeming one is `tokenRedeem` — 30 per address / minute, loose because the
 * token is unforgeable and a false refusal lands on a locked-out customer. Both
 * used to be one 5-per-minute IP bucket shared with eight other actions, so a
 * few ordinary sign-ins behind an office NAT meant no reset email at all — and,
 * because this endpoint is enumeration-safe, no explanation either.
 *
 * Tombstones (auth-006): a soft-deleted user is NOT a resettable account.
 * `authorize()` filters `deletedAt: null`, so a tombstoned row can never sign
 * in; both lookups below therefore filter it too. Until 2026-09-28 they did
 * not, and the reset ran to completion on a deleted account — it rewrote the
 * password hash, advanced `sessionVersion`, and returned success, so the app
 * told a locked-out customer their new password was set and then still refused
 * it. Two harms, both closed here: the false success, and the WRITE to a row
 * inside the retention window CLAUDE.md promises is restorable with a single
 * `UPDATE … SET "deletedAt" = NULL`.
 *
 * Both reads are `findFirst`, not `findUnique`, for a reason that is easy to
 * undo by accident: Prisma's `findUnique` accepts only unique fields in
 * `where`, so it CANNOT carry `deletedAt: null`. Changing either back to
 * `findUnique` silently reopens the hole.
 *
 * Note what does NOT change: `requestPasswordResetAction` returns the same
 * envelope for a tombstone that it returns for an address that was never
 * registered. The anti-enumeration posture above is deliberate, and a distinct
 * "that account was deleted" response would turn this endpoint into an oracle
 * for it. Only `resetPasswordAction` — which is reached solely by someone
 * already holding a valid signed token for that user — says so out loud.
 *
 * Enumeration on the two channels a human never sees (auth-010). The posture
 * above was maintained on the SCREEN and leaked twice underneath it:
 *
 *   • THE PAYLOAD. A server action's return value is serialised into the POST
 *     response body, which is readable with curl. This action used to return
 *     `{ dispatched: false }` for an unregistered or tombstoned address and
 *     `{ dispatched: result.delivered }` for a live one — `true` wherever
 *     GMAIL_USER / GMAIL_APP_PASSWORD are set, which CLAUDE.md lists as
 *     required production variables and a production build now refuses to
 *     proceed without. So on every healthy deployment the response body
 *     answered the question the page declines to. prodready-005 closed the
 *     rendered half only, and `app/forgot-password/page.tsx` is careful not to
 *     read the flag — which changes nothing for someone reading the body.
 *     The field is now gone from the contract rather than pinned to a constant:
 *     nothing ever read it (only caller: the page, which ignores it), and a
 *     hardcoded `false` is a footgun for whoever next needs a delivery signal.
 *
 *   • THE CLOCK. The unregistered branch returned after one indexed `SELECT`;
 *     the registered branch minted a token and then awaited a Gmail SMTP round
 *     trip inline. Hundreds of milliseconds against tens is a louder oracle
 *     than the flag was, and no amount of care over the response body hides it.
 *     The send is therefore no longer on the response path, and every outcome
 *     is held to one latency floor — see `RESPONSE_FLOOR_MS`.
 *
 * Both are enforced structurally: there is exactly ONE exit from the body of
 * `requestPasswordResetAction` below the rate-limit gate, returning one shared
 * frozen object after one floor. A future branch cannot diverge in shape or in
 * timing without deleting that structure, which is visible in review in a way
 * that a fourth `return { success: true, … }` would not be.
 */

import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { gateAuthAction } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { appOrigin } from "@/lib/env";
import { captureServerError } from "@/lib/sentry-server";
import { escapeHtml } from "@/lib/email/html";
import { sendEmail } from "@/lib/email/send";
import {
  passwordVersion,
  signPasswordResetToken,
  verifyPasswordResetToken,
} from "@/lib/auth/password-reset-token";
import { RequestPasswordResetSchema, ResetPasswordSchema } from "@/lib/schemas/password-reset";

import type { ActionResult } from "@/lib/actions/types";

/**
 * The origin every link in this file is concatenated onto.
 *
 * `appOrigin` (lib/env.ts) is the ONE decision — prodready-004. This used to be
 * its own `process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"`, one of
 * seven such copies, and one of the six that did NOT strip a trailing slash: an
 * origin pasted out of a browser address bar (`https://app.founderflow.com/`)
 * produced `https://app.founderflow.com//reset-password?token=…`, a URL that
 * works in one mail client and 404s in the next, in front of someone who cannot
 * sign in. `appOrigin` also trims whitespace, which `.replace(/\/$/, "")`
 * silently fails to handle when a pasted value ends in a space.
 *
 * The raw value is passed EXPLICITLY rather than relying on the default
 * argument, so the read stays at call time exactly as it is today. The default
 * argument would snapshot `env.NEXT_PUBLIC_APP_URL` at module load instead.
 */
function resetLinkBase(): string {
  return appOrigin(process.env.NEXT_PUBLIC_APP_URL);
}

/**
 * The ONE envelope every outcome of `requestPasswordResetAction` returns —
 * unknown address, tombstone, live account, and internal failure (auth-010).
 *
 * A single shared object rather than four identical literals, because identical
 * literals are what drifted: `{ dispatched: result.delivered }` looked like the
 * other three until SMTP was configured, and then it answered "yes, that address
 * has an account". `ActionResult<void>` carries no payload at all, so there is
 * nothing left for a branch to differ on. Frozen so a caller cannot decorate the
 * shared instance and change what a later caller receives.
 */
const REQUEST_ACCEPTED: ActionResult<void> = Object.freeze({
  success: true,
  data: undefined,
}) as ActionResult<void>;

/**
 * Uniform response latency for the reset request, in milliseconds.
 *
 * The second half of auth-010. A registered address used to cost a Gmail SMTP
 * round trip and an unregistered one a single indexed `SELECT`, so the response
 * TIME answered the question the response BODY no longer does. Two changes close
 * it together: the send is dispatched without being awaited, and every outcome
 * then waits out this floor before answering.
 *
 * The floor also does a second, unrelated job that is the reason it exists at
 * all rather than just dropping the `await`. A server action that returns
 * immediately gives a fire-and-forget send no runway: on Vercel the function can
 * be frozen once the response is complete, and a dropped password-reset email is
 * a worse bug than the leak this closes, because password reset is the only
 * self-service recovery path in the product. Holding the response for ~0.75s
 * gives the send that much runway, while a slow or wedged one no longer delays
 * (or reveals) anything.
 *
 * ~0.75s IS NOT ENOUGH TO BE SURE, and this used to claim otherwise. The claim
 * was that "a typical SMTP send finishes before the response is even serialised",
 * resting on `lib/email/send.ts` caching its transporter. It does cache one — but
 * it never passes `pool: true`, and a non-pooled nodemailer SMTPTransport
 * constructs a new SMTPConnection per message (`node_modules/nodemailer/lib/
 * smtp-transport/index.js`, in `send()`), so EVERY message pays a fresh TCP +
 * TLS + AUTH handshake to smtp.gmail.com:465. From a cold Vercel instance that
 * can exceed 750ms, and then the send is still in flight when the response goes
 * out. What the floor actually provides is a bounded runway, not a guarantee.
 *
 * Why it is left at a bounded runway rather than closed properly:
 *   • Awaiting the send would restore the oracle exactly — the wait would once
 *     again be longer for a registered address. Waiting for it with a CAP equal
 *     to the floor is what the code already does.
 *   • `pool: true` would not help the case at risk. A reset is one message per
 *     invocation, so the send that matters is always the first one in that
 *     instance, and the first send in a pool pays the same cold handshake. It
 *     would also keep an idle socket open in a runtime that freezes instances,
 *     on the shared module every other email path in the app uses.
 *   • The real fix is to take the send off the response path properly —
 *     `after()` from next/server (Next 15; this repo is on 14.2.35) or an outbox
 *     row a cron retries. Both are out of scope here and neither is a comment.
 * So the residual risk is accepted and made VISIBLE instead: a send that has not
 * settled by the time the floor expires is reported to Sentry as
 * `requestPasswordResetAction:send-outran-floor`. It used to be silent, which is
 * the worst property a dropped reset email can have.
 *
 * 750ms is around what the awaited Gmail handshake already cost, so a registered
 * address does not wait longer than it used to; an unregistered one now waits as
 * long as a registered one, which is the entire point and is not a cost anybody
 * legitimate pays twice. The floor is deliberately NOT randomised: jitter on top
 * of a floor only adds variance an attacker averages out over samples, and a
 * fixed floor is the thing a test can actually assert.
 */
const RESPONSE_FLOOR_MS = 750;

/**
 * `RESPONSE_FLOOR_MS` outside a test run, and the test override under one.
 *
 * WHY THE OVERRIDE IS NOT READABLE IN PRODUCTION. It used to be: any
 * `PASSWORD_RESET_RESPONSE_FLOOR_MS` that parsed as a non-negative number won,
 * in every environment. `0` in Vercel's Production scope therefore switched off
 * the entire second half of auth-010 — one line in a dashboard, no runtime
 * signal of any kind, and the timing oracle back exactly as it was. That is
 * prodready-002's shape (`RATE_LIMIT_DISABLED`) reproduced inside the fix for
 * something else, and prodready-002 was closed by making the thing refuse rather
 * than by writing "don't set this".
 *
 * So the knob is honoured ONLY under vitest, which is the only place it has ever
 * been used. Production, preview and `npm run dev` all get `RESPONSE_FLOOR_MS`
 * and there is no environment variable that lowers it. A production build
 * additionally refuses to proceed if the var is set at all
 * (`scripts/vercel-build.mjs`, FORBIDDEN_PROD_ENV) — belt and braces, and
 * because a variable that is silently ignored is its own trap: the next reader
 * "fixes" the code to honour it.
 *
 * Under test the default is 0: four suites drive this action in loops (the gate
 * wiring test alone makes ~40 calls), which at 750ms each would add half a
 * minute of sleeping and push them past vitest's timeout. The floor is a latency
 * shape rather than a decision, so skipping the sleep skips no logic — and the
 * tests in `tests/lib/actions/password-reset-enumeration.test.ts` that are ABOUT
 * the floor set the override explicitly, so the behaviour is exercised rather
 * than configured away.
 *
 * Read at call time, never at module load, so a test can set it per case.
 */
function responseFloorMs(): number {
  const underTest = Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
  if (!underTest) return RESPONSE_FLOOR_MS;
  const raw = process.env.PASSWORD_RESET_RESPONSE_FLOOR_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/** Sentry `action` tag for a send still in flight when the response went out. */
const SEND_OUTRAN_FLOOR = "requestPasswordResetAction:send-outran-floor";

/**
 * Wait out whatever is left of the floor since `startedAt`, and report whether
 * `pending` — the unawaited send, when there was one — is still in flight at the
 * end of it.
 *
 * The floor is the only runway the send gets (see `RESPONSE_FLOOR_MS`). A send
 * that outlives it may be truncated when the serverless instance is frozen, and
 * `sendEmail` cannot report that: it reports what IT observes, and a connection
 * killed underneath it is never observed by anyone. Returning the overrun is how
 * a dropped reset email stops being silent.
 *
 * Deliberately does not extend the wait by one millisecond — extending it is the
 * oracle this whole mechanism exists to remove.
 */
async function holdResponseFloor(startedAt: number, pending?: Promise<unknown>): Promise<boolean> {
  const floor = responseFloorMs();
  let settled = pending === undefined;
  if (pending) {
    const markSettled = () => {
      settled = true;
    };
    // Both handlers, because a rejected send is just as finished as a sent one —
    // and because attaching only `then` would make this a second unhandled
    // rejection path, which is the thing the caller's `.catch` exists to avoid.
    void pending.then(markSettled, markSettled);
  }
  const remaining = floor - (Date.now() - startedAt);
  if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  // `floor > 0` because with the floor disabled (tests only) there is no runway
  // to have overrun, and reporting every send there would be noise that trains
  // people to mute the alert.
  return floor > 0 && !settled;
}

export async function requestPasswordResetAction(input: unknown): Promise<ActionResult<void>> {
  const parsed = RequestPasswordResetSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid email" };
  }
  const { email } = parsed.data;

  // The "we will now send a human an email" class (auth-007): 10 per client
  // address per 10 minutes, AND 5 per target address per 15 minutes. Below the
  // parse because the per-account key IS the submitted address — `safeParse` is
  // pure and touches no database, so an unparseable flood still costs nothing.
  //
  // Keyed on the SUBMITTED address, never on the looked-up user, so the
  // allowance is identical whether the account exists, never existed or is
  // tombstoned. Keying the found user would make the number of requests this
  // endpoint accepts an oracle for "is this address registered", which is the
  // exact posture the header above exists to protect.
  const ip = await getClientIp();
  const gate = gateAuthAction({ kind: "emailDispatch", ip, account: email });
  if (!gate.allowed) {
    return { success: false, error: gate.error ?? "Too many requests" };
  }

  // Deliberately started AFTER the gate: a throttle refusal is the one thing this
  // endpoint is allowed to say, it is keyed on the submitted address so it is
  // identical for an absent, present and tombstoned one, and it carries no
  // account information — so it gets the cheap fast answer a valve should give,
  // and holding it would only make the limiter expensive to enforce.
  const startedAt = Date.now();

  // Hoisted out of the try so the floor below can tell whether the send it was
  // giving runway to actually finished. `undefined` on every branch that sends
  // nothing, which is also every branch that has nothing to lose.
  let sending: Promise<unknown> | undefined;

  try {
    const user = await db.user.findFirst({
      // `deletedAt: null` is why this is findFirst — findUnique cannot express it.
      where: { email, deletedAt: null },
      select: { id: true, name: true, passwordHash: true },
    });

    // Anti-enumeration: same success path, and the same latency, whether the
    // account exists, never existed, or has been tombstoned. The email only
    // fires when it is live — and it fires without being waited for, so it
    // cannot put the answer to "does this account exist" on the clock.
    if (user) {
      // Bind the token to the current password hash so a successful reset (which
      // rewrites the hash) makes this and any other outstanding link single-use.
      const token = await signPasswordResetToken(user.id, passwordVersion(user.passwordHash));
      const url = `${resetLinkBase()}/reset-password?token=${encodeURIComponent(token)}`;

      const html = `
      <div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;">
        <h2 style="margin:0 0 12px 0;">Reset your FounderFlow password</h2>
        <p>Hi ${escapeHtml(user.name)},</p>
        <p>We received a request to reset the password for the account associated with this email address. Click the button below to choose a new password. The link expires in 15 minutes.</p>
        <p style="margin:24px 0;">
          <a href="${url}" style="background:#10B981;color:#1F2933;padding:12px 20px;border-radius:8px;font-weight:700;text-decoration:none;">
            Reset password
          </a>
        </p>
        <p style="color:#666;font-size:12px;">If the button doesn't work, paste this URL into your browser:</p>
        <p style="color:#666;font-size:12px;word-break:break-all;">${url}</p>
        <p style="color:#666;font-size:12px;">If you didn't ask to reset your password, ignore this email — your account stays as-is.</p>
      </div>
    `;
      const text = `Reset your FounderFlow password: ${url}\n\nThe link expires in 15 minutes. If you didn't ask to reset, ignore this email.`;

      // NOT awaited — that `await` was the timing oracle. The floor below gives
      // the handshake its runway, and `sendEmail` already reports its own
      // outcomes (`sendEmail:no-transport`, `sendEmail`) to Sentry, so nothing
      // observable is lost by dropping the result: no caller ever read it.
      //
      // THE `.catch` IS LOAD-BEARING, and the reason given here before was
      // wrong. It said `getTransport()` runs before sendEmail's try/catch and
      // throws on a malformed credential. There is no `getTransport` — it is
      // `getTransporter` (lib/email/send.ts) — it returns `null` rather than
      // throwing when the credentials are missing, and
      // `nodemailer.createTransport({ service: "gmail", … })` does not contact
      // anything or validate anything at construction, so a bad password surfaces
      // later, inside `sendMail`, which IS covered.
      //
      // What is actually true, and is the whole reason to keep this:
      //   • `sendEmail`'s try/catch wraps only the `await t.sendMail(...)`.
      //     Everything before it is outside — `getTransporter()`, the
      //     unconfigured-send branch's `console.info`, and its
      //     `captureServerError` call into the Sentry SDK. A throw from any of
      //     those rejects the promise `sendEmail` returns.
      //   • Nothing else awaits this promise. Awaited, such a rejection landed in
      //     the `catch` below; unawaited and unhandled, Node's default is to
      //     terminate the process, taking every request in flight on that
      //     instance with it. The other fire-and-forget mail path,
      //     `lib/notify/email.ts`, is the same requirement met a different way:
      //     it wraps its whole unawaited IIFE in try/catch. This `.catch` IS
      //     that structure here.
      // So this is a boundary contract on a fire-and-forget promise, not a claim
      // about one known throw site. "sendEmail handles its own errors" is not a
      // reason to delete it: it handles the SEND, not itself.
      sending = sendEmail({
        to: email,
        subject: "Reset your FounderFlow password",
        html,
        text,
      }).catch((e) => captureServerError(e, { action: "requestPasswordResetAction:send" }));
    }
  } catch (e) {
    // Still answered as accepted below, to preserve the enumeration posture: a
    // Prisma outage must not be reportable to a probing client either. The
    // capture surfaces the real cause to the admin.
    captureServerError(e, { action: "requestPasswordResetAction" });
  }

  // ONE exit for every outcome — unknown address, tombstone, live account, and
  // internal failure — with one envelope and one latency. A branch that wanted
  // to say something different would have to add a `return` above this line,
  // which is the thing to refuse in review.
  const sendOutranFloor = await holdResponseFloor(startedAt, sending);
  if (sendOutranFloor) {
    // Runs AFTER the floor and before the return, so it costs no observable
    // time (a synchronous enqueue into the Sentry SDK) and cannot lengthen the
    // registered branch in a way a stopwatch could read. It is also reachable
    // only on a branch that sent something, i.e. only for a live account —
    // which is fine, because Sentry is not a channel the caller can see.
    captureServerError(
      new Error(
        "Password-reset e-mail had not finished sending when the response was returned. " +
          "The send is fire-and-forget with only the response floor as runway, so on a " +
          "serverless runtime it may have been dropped when the instance was frozen."
      ),
      { action: SEND_OUTRAN_FLOOR }
    );
  }
  return REQUEST_ACCEPTED;
}

export async function resetPasswordAction(
  input: unknown
): Promise<ActionResult<{ email: string }>> {
  // Redeeming a signed link — its own loose class, and deliberately NOT the
  // bucket the request half above uses. A reset token is an HS256 JWT bound to
  // the current password hash, so the defence against a guessed one is
  // cryptographic; the numeric limit here is a courtesy valve against a hot
  // loop, and the cost of a false refusal is telling a locked-out customer that
  // their single-use link is "too many requests" (auth-007).
  const ip = await getClientIp();
  const gate = gateAuthAction({ kind: "tokenRedeem", ip });
  if (!gate.allowed) {
    return { success: false, error: gate.error ?? "Too many requests" };
  }

  const parsed = ResetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid password" };
  }
  const { token, password } = parsed.data;

  const verified = await verifyPasswordResetToken(token);
  if (!verified.ok) {
    return {
      success: false,
      error:
        verified.reason === "expired"
          ? "This reset link has expired. Request a new one."
          : "This reset link is invalid. Request a new one.",
    };
  }

  try {
    const user = await db.user.findFirst({
      // Same tombstone filter as `authorize()`, in the SAME query as the read,
      // so there is no window in which the row is fetched and then written
      // before anyone checks whether it still exists. findUnique cannot carry
      // this filter; do not change it back.
      where: { id: verified.userId, deletedAt: null },
      select: { id: true, email: true, passwordHash: true },
    });
    if (!user) {
      // Covers both "never existed" and "deleted". A holder of a valid signed
      // token for this id is the account owner, so naming it leaks nothing and
      // replaces a success envelope that was a lie.
      return { success: false, error: "This account no longer exists." };
    }
    // Single-use enforcement: the token's pv must still match the live hash.
    // Once a reset lands, the hash (and pv) change, so a replayed or stale
    // link — including one issued before an earlier reset — is rejected here.
    if (verified.pv !== passwordVersion(user.passwordHash)) {
      return {
        success: false,
        error: "This reset link has already been used. Request a new one.",
      };
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await db.user.update({
      where: { id: user.id },
      // Bump sessionVersion so any other live session (incl. a hijacked one
      // that prompted the reset) is force-signed-out on its next request.
      data: { passwordHash, sessionVersion: { increment: 1 } },
    });
    return { success: true, data: { email: user.email } };
  } catch (e) {
    captureServerError(e, { action: "resetPasswordAction" });
    return { success: false, error: "Couldn't reset your password right now. Try again shortly." };
  }
}
