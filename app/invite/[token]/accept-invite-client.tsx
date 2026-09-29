"use client";

/**
 * Password-set form for /invite/[token]. Calls acceptInviteAction which
 * creates the user, marks the token used, and auto-signs them in. On
 * success we hard-nav to /dashboard so middleware sees the new session.
 */

import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import toast from "react-hot-toast";
import { acceptInviteAction } from "@/lib/actions/team";
import { AcceptInviteSchema, type AcceptInviteInput } from "@/lib/schemas/user";
import { cn } from "@/lib/utils";
import { useHydrated } from "@/lib/hooks/use-hydrated";

export function AcceptInviteClient({
  token,
  inviteeName,
  inviteeEmail,
}: {
  token: string;
  inviteeName: string;
  inviteeEmail: string;
}) {
  /**
   * FaultsAudit A14. Full argument: lib/hooks/use-hydrated.ts.
   *
   * This form is server-rendered with the invite token already in a hidden
   * field, so a click that beats hydration used to perform a native GET
   * carrying both the token and the password the new teammate just chose. It
   * is also the auth form most likely to be opened on a phone from an email
   * client's in-app browser — a cold, slow first paint on hardware that makes
   * the window wide. One field blocks implicit submission, so Enter fired it
   * too.
   */
  const hydrated = useHydrated();
  const pwId = useId();
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<AcceptInviteInput>({
    resolver: zodResolver(AcceptInviteSchema),
    defaultValues: { token, password: "" },
  });

  async function onSubmit(data: AcceptInviteInput) {
    try {
      const res = await acceptInviteAction(data);
      if (res.success) {
        toast.success(`Welcome to FounderFlow, ${inviteeName.split(" ")[0]}!`);
        window.location.href = "/dashboard";
        return;
      }
      toast.error(res.error || "Couldn't accept invite");
    } catch (err) {
      console.error("acceptInviteAction threw:", err);
      toast.error("We couldn't reach the server. Try again.");
    }
  }

  return (
    // method="post" is load-bearing — see lib/hooks/use-hydrated.ts. A GET
    // here would
    // put the invite token and the chosen password in the same URL.
    <form method="post" onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      {/* Token + email are read-only context for the user, never editable. */}
      <input type="hidden" {...register("token")} />

      <div className="rounded-xl border border-glass/[0.10] bg-glass/[0.05] px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted">
          Signing in as
        </p>
        <p className="mt-1 text-sm font-semibold text-fg">{inviteeEmail}</p>
        <p className="mt-0.5 text-xs text-fg-muted">{inviteeName}</p>
      </div>

      <div>
        <label
          htmlFor={pwId}
          className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
        >
          Choose a password
        </label>
        <div className="relative">
          <input
            id={pwId}
            type={showPassword ? "text" : "password"}
            placeholder="8+ chars, mixed case & a number"
            autoComplete="new-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? `${pwId}-err` : undefined}
            {...register("password")}
            className={cn(
              "w-full rounded-xl border bg-glass/[0.05] px-4 py-3 pe-12 text-sm text-fg transition-colors placeholder:text-fg-muted focus:bg-glass/[0.08] focus:outline-none",
              errors.password
                ? "border-danger/60 focus:border-danger"
                : "border-glass/[0.10] focus:border-primary/50"
            )}
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute end-3 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-glass/[0.05] hover:text-fg"
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
        {errors.password && (
          <p id={`${pwId}-err`} className="mt-1.5 text-xs text-danger">
            {errors.password.message}
          </p>
        )}
      </div>

      {/* Inert until hydrated — closes both the click and the Enter-key path.
          Styling stays normal in that window; see app/login/page.tsx. */}
      <button
        type="submit"
        disabled={!hydrated || isSubmitting}
        className={cn(
          "group inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-5 py-3.5 text-sm font-bold text-primary-fg shadow-[0_0_30px_rgb(var(--primary)_/_0.25)] transition-all hover:scale-[1.01] hover:shadow-[0_0_45px_rgb(var(--primary)_/_0.4)] active:scale-95",
          hydrated && "disabled:opacity-60 disabled:hover:scale-100"
        )}
      >
        {isSubmitting ? "Activating…" : "Accept & sign in"}
        <ArrowRight
          className="h-4 w-4 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
          aria-hidden="true"
        />
      </button>
    </form>
  );
}
