/**
 * Email sender — single entry point for every transactional email.
 *
 * Behavior:
 *   • If RESEND_API_KEY is set → real send via Resend.
 *   • If unset (typical dev) → logs the email content + any action URL to
 *     the server console so you can copy/paste the link to test. Returns
 *     `{ delivered: false, devLogged: true }` so callers can still flag
 *     "we tried" in their UI.
 *
 * This keeps local dev frictionless (no Resend account needed) while
 * production / preview deploys send real mail once the env var is set.
 */

import { Resend } from "resend";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text fallback for clients that don't render HTML. */
  text?: string;
}

export interface SendEmailResult {
  delivered: boolean;
  devLogged: boolean;
  error?: string;
}

const FROM_ADDRESS = process.env.EMAIL_FROM ?? "FounderFlow <onboarding@resend.dev>";

export async function sendEmail({
  to,
  subject,
  html,
  text,
}: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Dev mode: log to server console + return without erroring so the
    // caller's flow continues. The URL inside the HTML is what the dev
    // copy-pastes into a browser to simulate the click.
    // eslint-disable-next-line no-console
    console.info(
      `[email:dev-stub] would have sent to=${to} subject="${subject}"\n----- HTML -----\n${html}\n----- /HTML -----`
    );
    return { delivered: false, devLogged: true };
  }

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to,
      subject,
      html,
      text,
    });
    if (error) {
      return { delivered: false, devLogged: false, error: error.message };
    }
    return { delivered: true, devLogged: false };
  } catch (e) {
    return {
      delivered: false,
      devLogged: false,
      error: e instanceof Error ? e.message : "Unknown email error",
    };
  }
}
