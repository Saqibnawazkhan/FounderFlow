"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, CheckCircle2, Loader2, ShieldAlert } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { confirmEmailChangeAction } from "@/lib/actions/email-change";
import { ThemeToggle } from "@/components/landing/theme-toggle";
import { useT } from "@/lib/i18n/use-t";

/**
 * /verify-email-change?token=… — landing page for the email-change
 * confirmation link. Applies the swap on mount via the self-authenticating
 * token (no session needed — may be opened on a different device). Mirrors
 * the /verify-email shell.
 */
export default function VerifyEmailChangePage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}

type State = { kind: "verifying" } | { kind: "success" } | { kind: "error"; message: string };

function Inner() {
  const t = useT();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [state, setState] = useState<State>({ kind: "verifying" });
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    if (!token) {
      setState({ kind: "error", message: t.settings.changeEmailInvalidBody });
      return;
    }
    let cancelled = false;
    confirmEmailChangeAction({ token }).then((res) => {
      if (cancelled) return;
      if (res.success) setState({ kind: "success" });
      else setState({ kind: "error", message: res.error });
    });
    return () => {
      cancelled = true;
    };
  }, [token, t.settings.changeEmailInvalidBody]);

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-bg px-6 py-16">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgb(var(--primary)/0.10),transparent_60%)]"
      />
      <div className="absolute right-6 top-6">
        <ThemeToggle size="sm" />
      </div>
      <div className="w-full max-w-md">
        <Link href="/" className="mb-10 inline-flex items-center gap-2.5">
          <BrandMark className="h-9 w-9" />
          <span className="text-base font-bold tracking-tight">FounderFlow</span>
        </Link>

        {state.kind === "verifying" && (
          <div className="rounded-2xl border border-glass/[0.10] bg-glass/[0.05] p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary-strong">
              <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">
              {t.settings.changeEmailConfirming}
            </h1>
          </div>
        )}

        {state.kind === "success" && (
          <div className="rounded-2xl border border-glass/[0.10] bg-glass/[0.05] p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary-strong">
              <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">{t.settings.changeEmailDoneTitle}</h1>
            <p className="mt-3 text-sm text-fg-muted">{t.settings.changeEmailDoneBody}</p>
            <Link
              href="/dashboard"
              className="mt-8 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-95"
            >
              {t.auth.verifiedCta}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        )}

        {state.kind === "error" && (
          <div className="rounded-2xl border border-danger/30 bg-danger/[0.06] p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger/15 text-danger">
              <ShieldAlert className="h-6 w-6" aria-hidden="true" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">
              {t.settings.changeEmailInvalidTitle}
            </h1>
            <p className="mt-3 text-sm text-fg-muted">{state.message}</p>
            <Link
              href="/settings"
              className="mt-8 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-95"
            >
              {t.nav.settings}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
