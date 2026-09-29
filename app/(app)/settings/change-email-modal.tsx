"use client";

/**
 * "Change email" modal. Sends a confirmation link to the NEW address; the
 * email only switches when that link is clicked (see lib/actions/email-change).
 * On success we show a "check the new inbox" state rather than closing, so the
 * user knows the change isn't done until they confirm.
 */

import { useId, useState } from "react";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { MailCheck, Send } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { requestEmailChangeAction } from "@/lib/actions/email-change";
import { RequestEmailChangeSchema } from "@/lib/schemas/email-change";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  currentEmail: string;
};

// Extends rather than replaces the shared schema, so the server's contract and
// the form's stay in step if `password` is folded into the shared one later.
const FormSchema = RequestEmailChangeSchema.extend({
  password: z.string().min(1, "Enter your current password"),
});
type FormValues = z.infer<typeof FormSchema>;

export function ChangeEmailModal({ open, onClose, currentEmail }: Props) {
  const t = useT();
  const emailId = useId();
  const passwordId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  /**
   * acct-016. The server's refusal, kept on the screen.
   *
   * A toast was the whole delivery, and the toaster's duration is 3500ms
   * (components/providers.tsx). That was survivable while every refusal here was
   * a short verdict; acct-016 replaced the collision message with an
   * INSTRUCTION — "That email belongs to a FounderFlow account that was deleted.
   * Contact support to restore it, or use a different address."
   * (lib/actions/email-change.ts:250) — and an instruction the reader cannot
   * re-read is an instruction they cannot follow. The toast still fires, because
   * it is what pulls the eye back; it is no longer the only copy.
   */
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { newEmail: "", password: "" },
  });

  function onClosed() {
    reset({ newEmail: "", password: "" });
    setSentTo(null);
    setFormError(null);
    onClose();
  }

  async function onSubmit(data: FormValues) {
    setSubmitting(true);
    // Cleared before the attempt, not after it: a refusal left under a fresh
    // submission reads as a second failure.
    setFormError(null);
    const res = await requestEmailChangeAction(data);
    setSubmitting(false);
    if (!res.success) {
      setFormError(res.error);
      toast.error(res.error);
      return;
    }
    setSentTo(res.data.newEmail);
  }

  return (
    <Modal open={open} onClose={onClosed} title={t.settings.changeEmail} size="sm">
      {sentTo ? (
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary-strong">
            <MailCheck className="h-6 w-6" aria-hidden="true" />
          </div>
          <p className="text-sm text-fg">
            {t.settings.changeEmailSentBody.replace("{email}", sentTo)}
          </p>
          <button
            type="button"
            onClick={onClosed}
            className="mt-6 rounded-full bg-primary px-5 py-2 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.02] active:scale-95"
          >
            {t.settings.cancel}
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <p className="text-sm text-fg-muted">
            {t.settings.changeEmailDesc.replace("{email}", currentEmail)}
          </p>
          <div>
            <label
              htmlFor={emailId}
              className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
            >
              {t.settings.newEmail}
            </label>
            <input
              id={emailId}
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@newdomain.com"
              aria-invalid={errors.newEmail ? true : undefined}
              {...register("newEmail")}
              className={cn(
                "w-full rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 focus:bg-surface focus:outline-none",
                errors.newEmail
                  ? "border-danger/60 focus:border-danger"
                  : "border-border focus:border-primary/50"
              )}
            />
            {errors.newEmail && (
              <p className="mt-1.5 text-xs text-danger">{errors.newEmail.message}</p>
            )}
          </div>
          <div>
            <label
              htmlFor={passwordId}
              className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
            >
              {t.settings.currentPassword}
            </label>
            <input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              aria-invalid={errors.password ? true : undefined}
              {...register("password")}
              className={cn(
                "w-full rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 focus:bg-surface focus:outline-none",
                errors.password
                  ? "border-danger/60 focus:border-danger"
                  : "border-border focus:border-primary/50"
              )}
            />
            {errors.password && (
              <p className="mt-1.5 text-xs text-danger">{errors.password.message}</p>
            )}
          </div>
          {/* Same shape as app/forgot-password/page.tsx:198 — role="alert" so a
              screen reader is told, and in the dialog so the instruction is still
              there after the toast has gone. */}
          {formError && (
            <p role="alert" className="text-xs font-medium text-danger">
              {formError}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClosed}
              className="rounded-full border border-border px-4 py-2 text-sm font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
            >
              {t.settings.cancel}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60"
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              {submitting ? t.settings.saving : t.settings.changeEmailSend}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
