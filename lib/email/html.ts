/**
 * The one HTML escaper for email bodies.
 *
 * WHY THIS FILE EXISTS. It did not, and `escapeHtml` was copy-pasted into three
 * modules — lib/email/templates/invite.ts, notification.ts and
 * security-notice.ts — byte-identical, each private to its own file, while the
 * three other places that build an email body (lib/email/verification.ts,
 * lib/actions/email-change.ts, lib/actions/password-reset.ts) interpolated a
 * customer's name with no escaping at all (audit auth-016). Three private copies
 * of a five-line security primitive is three chances for one to drift, and the
 * one that drifts is the one nobody re-reads, because it looks like the two that
 * are right. tests/lib/email/escape-boundary.test.ts now fails if a second
 * definition appears anywhere under lib/, and if any email body interpolates a
 * value without passing it through here.
 *
 * SCOPE, stated so nobody reaches for it as a general sanitiser: this is
 * ESCAPING for HTML text and quoted-attribute contexts, not sanitising. It
 * renders a value inert as markup; it does not make an untrusted URL safe to put
 * in an `href` (a `javascript:` scheme survives it untouched), and it is the
 * wrong tool inside a `<script>` or a `style` value. Email bodies here use it
 * only for text and quoted attributes, which is what it is correct for.
 *
 * React needs none of this — JSX escapes text children itself. These bodies are
 * strings handed to nodemailer, so nothing escapes them but this.
 */

/**
 * `&` first, always. Replacing it after the others would re-escape the `&` those
 * four just produced, turning `<` into `&amp;lt;` — which the customer reads as
 * literal "&lt;" in their inbox.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
