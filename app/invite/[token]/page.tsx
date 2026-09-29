/**
 * /invite/[token] — Server Component. Looks the token up in Supabase before
 * rendering anything so we can show the right state immediately:
 *
 *   • valid → password form with the invitee's name + workspace prefilled
 *   • expired → "this link is past its 7-day window" empty state
 *   • used → "this invite has already been claimed" empty state
 *   • workspace deleted → "no longer active", in the action's own words
 *   • not found → generic invalid-link state
 *   • too many renders from one address → "wait a moment and reload", WITHOUT
 *     looking anything up (auth-008's GET half; see the gate below)
 *
 * Doing the lookup server-side means the recipient never sees a flash of
 * the form for a dead token.
 *
 * NOT a timing-oracle defence, which an earlier version of this comment
 * claimed: the lookup is an ordinary indexed unique read and the RESPONSE BODY
 * is the oracle anyway — a miss says "invalid link", a hit prints the invitee's
 * first name, e-mail, workspace and role. That is only reachable by someone who
 * already holds a 64-hex-character token (~244 bits, lib/actions/team.ts), so it
 * discloses nothing about the token space, and timing is not the exposure.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { db } from "@/lib/db";
import { getClientIp } from "@/lib/client-ip";
import { gateAuthAction } from "@/lib/rate-limit";
import { AcceptInviteClient } from "./accept-invite-client";

export const metadata: Metadata = {
  title: "Accept invite",
  description: "Set your password to join the workspace.",
};

export default async function InvitePage({ params }: { params: { token: string } }) {
  // auth-008, THE GET HALF — and the half the first fix for it missed. Metering
  // `acceptInviteAction` closed the POST and left this line running one indexed
  // `inviteToken.findUnique` per anonymous GET, unbounded, which is the surface
  // an attacker would have picked anyway: no Next-Action header, no
  // server-action encoding, the same unique read, plus a whole RSC render on
  // top. /invite/* is public in auth.config.ts and middleware wires only
  // NextAuth, so there is no valve in front of this either.
  //
  // ITS OWN BUCKET, NOT `tokenRedeem`'s (lib/rate-limit.ts `invitePageIp`),
  // so that a flood of renders can never refuse the submit of somebody who
  // already has the form open. 15/min/address, and it fails OPEN where no
  // proxy supplies a trustworthy address — off Vercel and without
  // TRUSTED_PROXY_HEADER this gate is a documented no-op rather than one
  // shared bucket every visitor in the world can be locked out of.
  //
  // BEFORE THE LOOKUP, which is the entire point: a refused render must cost
  // no database round trip.
  const gate = gateAuthAction({ kind: "invitePageView", ip: await getClientIp() });
  if (!gate.allowed) {
    return (
      <InviteEmpty
        title="Too many requests from this connection"
        // NOT the invalid-link copy, deliberately. The person most likely to
        // meet this is someone reloading, or a mail client fetching the URL for
        // a preview — telling them their link is broken would turn a 60-second
        // valve into a lost signup.
        //
        // AND IT DOES NOT PROMISE THE LINK IS GOOD, because we did not look:
        // the whole point of refusing above the query is that this branch knows
        // nothing about the token. What it can honestly say is that refusing a
        // render wrote nothing, so the link is in whatever state it was in.
        body={`We haven't looked your invite up, so nothing about it has changed — wait a moment and reload this page. ${
          gate.error ?? "Too many requests."
        }`}
      />
    );
  }

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
  // auth-009, the PAGE half of data-integrity-003. `include: { company: true }`
  // above has always pulled `deletedAt` into scope and nothing read it, so an
  // invite that outlived its workspace rendered the full welcome — first name,
  // e-mail, workspace name, role, password field — and failed only on submit, at
  // lib/actions/team.ts. The security half is closed elsewhere and stays closed:
  // the action refuses a tombstoned company, and `softDeleteWorkspace` burns
  // every unused token in the same transaction as the tombstone, so no account
  // can be created here whatever this page draws. What was broken is that the two
  // surfaces disagreed about the same token, and that a workspace whose owner
  // asked us to erase it was still being named to whoever opened a stale link.
  //
  // The wording is the action's sentence, split across the title and body on
  // purpose — tests/app/invite/invite-page-dead-workspace.test.tsx reads the
  // string out of team.ts and asserts the halves, so rewording either surface
  // alone fails rather than letting them drift apart again.
  if (invite.company.deletedAt) {
    return (
      <InviteEmpty
        title="This workspace is no longer active"
        body="Ask whoever invited you for a new invite."
      />
    );
  }

  return (
    <main id="main" tabIndex={-1} className="min-h-screen bg-bg text-fg">
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
    <main id="main" tabIndex={-1} className="min-h-screen bg-bg text-fg">
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
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_0.25)] transition-transform hover:scale-[1.02] active:scale-95"
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
