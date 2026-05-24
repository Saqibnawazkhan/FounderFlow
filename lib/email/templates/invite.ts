/**
 * Plain-HTML invite email template. Inlined styles because every email
 * client treats <style> tags differently — inline survives Gmail / Outlook
 * / Apple Mail without breaking. No images, no remote resources, so it
 * also lands cleanly in spam-conscious filters.
 */

export interface InviteEmailVars {
  inviteeName: string;
  inviterName: string;
  companyName: string;
  /** Role to display in the email body, capitalized for English. */
  roleLabel: string;
  /** Fully-qualified accept URL — built by the caller from APP_URL + token. */
  acceptUrl: string;
}

export function renderInviteEmail(v: InviteEmailVars): { html: string; text: string } {
  const safeName = escapeHtml(v.inviteeName);
  const safeInviter = escapeHtml(v.inviterName);
  const safeCompany = escapeHtml(v.companyName);
  const safeRole = escapeHtml(v.roleLabel);

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,sans-serif;color:#f7f8f5;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0a0a0a;padding:48px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#161616;border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:40px 32px;">
          <tr>
            <td>
              <p style="margin:0 0 8px;font-family:ui-monospace,'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#94a3b8;">FounderFlow</p>
              <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#f7f8f5;line-height:1.3;">You're invited to ${safeCompany}</h1>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#cbd5e1;">Hey ${safeName},</p>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#cbd5e1;">${safeInviter} added you to <strong style="color:#f7f8f5;">${safeCompany}</strong> on FounderFlow as <strong style="color:#b6f425;">${safeRole}</strong>. Set your password and you'll be in.</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;">
                <tr>
                  <td>
                    <a href="${v.acceptUrl}" style="display:inline-block;background:#b6f425;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:14px;padding:14px 28px;border-radius:9999px;">Accept invite</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#94a3b8;">Or paste this link in your browser:</p>
              <p style="margin:0 0 24px;font-family:ui-monospace,'JetBrains Mono',monospace;font-size:12px;line-height:1.5;color:#cbd5e1;word-break:break-all;">${v.acceptUrl}</p>
              <hr style="border:0;border-top:1px solid rgba(255,255,255,0.06);margin:24px 0;" />
              <p style="margin:0;font-size:12px;line-height:1.55;color:#94a3b8;">This invite expires in 7 days. If you weren't expecting it, ignore this email — no account will be created.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `You're invited to ${v.companyName}

Hey ${v.inviteeName},

${v.inviterName} added you to ${v.companyName} on FounderFlow as ${v.roleLabel}.
Set your password to get in:

${v.acceptUrl}

This invite expires in 7 days. If you weren't expecting it, ignore this email.`;

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
