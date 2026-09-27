/**
 * The notification email.
 *
 * ONE template, parameterised — not one file per event. Every notification
 * email says the same four things (what happened, who did it, a line of
 * detail, a way back into the app), so five near-identical files would be five
 * places to forget to update when the brand or the footer changes.
 *
 * Inlined styles because every email client treats <style> tags differently —
 * inline survives Gmail / Outlook / Apple Mail. No images and no remote
 * resources, so it also lands cleanly in spam-conscious filters. Same
 * constraints (and structure) as templates/invite.ts.
 */

export interface NotificationEmailVars {
  /** Who is being written to; used for the greeting only. */
  recipientName: string;
  /** The notification title, e.g. "New task assigned". */
  title: string;
  /** The notification body — one sentence of detail. */
  message: string;
  /** Short label for what kind of event this was, shown as an eyebrow. */
  eventLabel: string;
  /** Fully-qualified deep link back into the app. Built by the caller. */
  actionUrl: string;
  /** Button copy, e.g. "Open task". */
  actionLabel: string;
  /** Fully-qualified /settings URL, so the footer's opt-out actually works. */
  preferencesUrl: string;
}

export function renderNotificationEmail(v: NotificationEmailVars): {
  html: string;
  text: string;
} {
  const name = escapeHtml(v.recipientName);
  const title = escapeHtml(v.title);
  const message = escapeHtml(v.message);
  const eventLabel = escapeHtml(v.eventLabel);
  const actionLabel = escapeHtml(v.actionLabel);

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#1F2933;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif;color:#FFFFFF;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#1F2933;padding:48px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#2A3642;border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:40px 32px;">
          <tr>
            <td>
              <p style="margin:0 0 8px;font-family:ui-monospace,'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#9CAFC3;">${eventLabel}</p>
              <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#FFFFFF;line-height:1.3;">${title}</h1>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#CBD5E1;">Hey ${name},</p>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#CBD5E1;">${message}</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
                <tr>
                  <td>
                    <a href="${v.actionUrl}" style="display:inline-block;background:#10B981;color:#1F2933;text-decoration:none;font-weight:700;font-size:14px;padding:14px 28px;border-radius:9999px;">${actionLabel}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#9CAFC3;">Or paste this link in your browser:</p>
              <p style="margin:0 0 24px;font-family:ui-monospace,'JetBrains Mono',monospace;font-size:12px;line-height:1.5;color:#CBD5E1;word-break:break-all;">${v.actionUrl}</p>
              <hr style="border:0;border-top:1px solid rgba(255,255,255,0.06);margin:24px 0;" />
              <p style="margin:0;font-size:12px;line-height:1.55;color:#9CAFC3;">You're getting this because your FounderFlow notification settings have email switched on for this kind of update. <a href="${v.preferencesUrl}" style="color:#34D399;">Change what you're emailed about</a>.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `${v.title}

Hey ${v.recipientName},

${v.message}

${v.actionLabel}: ${v.actionUrl}

—
You're getting this because your FounderFlow notification settings have email
switched on for this kind of update. Change that here: ${v.preferencesUrl}`;

  return { html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
