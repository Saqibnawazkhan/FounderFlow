/**
 * /invite/[token] — Server Component. Looks the token up in Supabase before
 * rendering anything so we can show the right state immediately:
 *
 *   • valid → password form with the invitee's name + workspace prefilled
 *   • expired → "this link is past its 7-day window" empty state
 *   • used → "this invite has already been claimed" empty state
 *   • not found → generic invalid-link state
 *
 * Doing the lookup server-side means the recipient never sees a flash of
 * the form for a dead token, and we don't leak the existence of valid
 * tokens via timing differences.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { db } from "@/lib/db";
import { AcceptInviteClient } from "./accept-invite-client";

export const metadata: Metadata = {
  title: "Accept invite",
  description: "Set your password to join the workspace.",
};

export default async function InvitePage({ params }: { params: { token: string } }) {
  const invite = await db.inviteToken.findUnique({
    where: { token: params.token },
    include: { company: true },
  });

  if (!invite) {
    return (
      <InviteEmpty
        title="This invite link is invalid"
        body="Double-check the URL, or ask the admin who invited you to send a new link."
      />
    );
  }
  if (invite.usedAt) {
    return (
      <InviteEmpty
        title="This invite has already been used"
        body="The account is active. Sign in with the password you set when you first accepted."
        cta={{ href: "/login", label: "Go to sign in" }}
      />
    );
  }
  if (invite.expiresAt < new Date()) {
    return (
      <InviteEmpty
        title="This invite has expired"
        body="Invite links are good for 7 days. Ask the admin who invited you to send a new one."
      />
    );
  }

  return (
    <main className="min-h-screen bg-bg text-fg">
      <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-12">
        <Link href="/" className="mb-10 inline-flex w-fit items-center gap-2.5">
          <BrandMark className="h-9 w-9" />
          <span className="text-base font-bold tracking-tight">FounderFlow</span>
        </Link>

        <div className="space-y-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">
            You&apos;ve been invited
          </p>
          <h1 className="text-balance text-4xl font-bold tracking-tight md:text-5xl">
            Welcome to <span className="text-primary-strong">{invite.company.name}</span>
          </h1>
          <p className="text-sm text-fg-muted md:text-base">
            Hey {invite.name.split(" ")[0]} — set your password and you&apos;re in. You&apos;ll join
            as{" "}
            <strong className="text-fg">
              {invite.role === "cofounder" ? "Co-Founder" : "Team Member"}
            </strong>
            .
          </p>
        </div>

        <div className="mt-8">
          <AcceptInviteClient
            token={params.token}
            inviteeName={invite.name}
            inviteeEmail={invite.email}
          />
        </div>

        <p className="mt-10 text-xs text-fg-muted">
          By accepting you agree to FounderFlow&apos;s terms. This invite expires{" "}
          {invite.expiresAt.toLocaleDateString()}.
        </p>
      </div>
    </main>
  );
}

function InviteEmpty({
  title,
  body,
  cta,
}: {
  title: string;
  body: string;
  cta?: { href: string; label: string };
}) {
  return (
    <main className="min-h-screen bg-bg text-fg">
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-12 text-center">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-warning/10">
          <AlertTriangle className="h-6 w-6 text-warning" aria-hidden="true" />
        </div>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-fg-muted">Invite</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-3 text-sm text-fg-muted">{body}</p>
        <div className="mt-6 flex gap-3">
          {cta ? (
            <Link
              href={cta.href}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(182_244_37_/_0.25)] transition-transform hover:scale-[1.02] active:scale-95"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {cta.label}
            </Link>
          ) : (
            <Link
              href="/login"
              className="inline-flex items-center rounded-full border border-border bg-surface px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-hover"
            >
              Back to sign in
            </Link>
          )}
        </div>
      </div>
    </main>
  );
}
