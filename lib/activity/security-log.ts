/**
 * The security half of the activity feed — sec-020.
 *
 * WHAT THIS IS FOR. The Activity table is how this product answers "who did
 * that, and when": `lib/actions/team.ts` writes a row for every role change,
 * invite and deactivation, and /activities shows them to the workspace's
 * administrators. The paths that touch a CREDENTIAL, or hand out the whole
 * dataset, wrote nothing — so the three questions a customer asks exactly once,
 * after something has already gone wrong, had no data behind them:
 *
 *   • "did someone export our books?"        GET /api/export
 *   • "when did my login email change?"      confirmEmailChangeAction
 *   • "did somebody change my password?"     changePasswordAction /
 *                                            resetPasswordAction
 *
 * WHY A ROW AND NOT JUST THE EMAIL. acct-005 already mails a security notice to
 * the address on file, and `warnOldAddress` already warns the address being
 * replaced. Those are ALERTS — one inbox, once, and deleting the message deletes
 * the evidence. A trail is a different artefact: it survives, it is ordered, it
 * is queryable, and it is already the surface admins read. An alert tells you
 * now; a trail lets you reconstruct later. Both are wanted.
 *
 * TWO FUNCTIONS, BECAUSE THE FAILURE POSTURE GENUINELY DIFFERS. This is the
 * whole reason the module exists rather than four inline `activity.create`
 * calls:
 *
 *   • `writeSecurityActivity` — lets the failure propagate. Used by the export
 *     route, where the row is written AFTER the reads and BEFORE any bytes
 *     leave. "No trail, no bulk download" costs a legitimate admin one retry,
 *     whereas an export with no row is unrecoverable: the row is the only record
 *     that it happened.
 *   • `tryWriteSecurityActivity` — swallows and reports to Sentry. Used by the
 *     three credential paths, where the `UPDATE` has ALREADY landed by the time
 *     this runs and cannot be undone. Failing there would tell the user their
 *     password did not change while it did, and send them to sign in with a
 *     credential the row no longer holds. Same guarantee, and the same reason,
 *     as `sendSecurityNotice` in lib/email/templates/security-notice.ts and
 *     `warnOldAddress` in lib/actions/email-change.ts.
 *
 * `type` IS TYPED, AND THAT IS LOAD-BEARING. `Activity.type` is a plain `String`
 * column (prisma/schema.prisma:552) while app/(app)/activities/activities-client
 * .tsx does `ACTIVITY_META[activity.type]` and dereferences the result with no
 * fallback — so a row carrying a type that is not a key of that map crashes
 * /activities for the whole workspace, permanently, because the row persists.
 * Prisma accepts any string, so nothing at the call site catches a typo. Taking
 * `ActivityType` here is what makes `tsc` catch it instead.
 *
 * NO METADATA. The `ActivityMetadata` union stays as it is: nothing reads a
 * security variant, and a blob nobody parses is this repo's "shipped, tested,
 * unreachable" shape. The facts live in `message`, which is what /activities
 * renders and what its search box filters on.
 */

import { db } from "@/lib/db";
import { captureServerError } from "@/lib/sentry-server";
import type { ActivityType } from "@/lib/types";

export type SecurityActivity = {
  companyId: string;
  /**
   * The account the event happened TO. On all four of today's paths that is
   * also the actor: an export is taken by the person whose session it is, and
   * nobody but the owner can move their own credential (an admin cannot reset a
   * teammate's password in this product). If a "reset a teammate's password"
   * control is ever added, this needs an actor/subject split rather than one id.
   */
  userId: string;
  userName: string;
  type: ActivityType;
  /** Prose, read forever. Never a secret, never a credential, never a payload. */
  message: string;
};

/** The row, exactly as every caller writes it. */
function rowFor(event: SecurityActivity) {
  return {
    companyId: event.companyId,
    type: event.type,
    message: event.message,
    userId: event.userId,
    userName: event.userName,
  };
}

/** Writes the row and lets a failure reach the caller. See the header. */
export async function writeSecurityActivity(event: SecurityActivity): Promise<void> {
  await db.activity.create({ data: rowFor(event) });
}

/** Writes the row; a failure is reported and swallowed. See the header. */
export async function tryWriteSecurityActivity(event: SecurityActivity): Promise<void> {
  try {
    await writeSecurityActivity(event);
  } catch (e) {
    // The credential change already landed. All that is lost is the row, and
    // losing it silently is the state sec-020 is about — so it is reported.
    captureServerError(e, {
      action: "tryWriteSecurityActivity",
      userId: event.userId,
      companyId: event.companyId,
      extra: { type: event.type },
    });
  }
}
