"use client";

/**
 * "Delete my account" modal. Re-auths with a password check inside the
 * server action even though the caller already has a session cookie —
 * see [lib/actions/account.ts] for the rationale.
 *
 * Behaviour on success: the server signs the user out and returns; this
 * component then hard-navigates to /login so middleware sees the cleared
 * cookie on the very next request.
 */

import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle } from "lucide-react";
import toast from "react-hot-toast";
import { Modal } from "@/components/ui/modal";
import { deleteAccountAction } from "@/lib/actions/account";
import { DeleteAccountSchema, type DeleteAccountInput } from "@/lib/schemas/account";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function DeleteAccountModal({ open, onClose }: Props) {
  const t = useT();
  const pwId = useId();
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<DeleteAccountInput>({
    resolver: zodResolver(DeleteAccountSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: { password: "" },
  });

  async function onSubmit(data: DeleteAccountInput) {
    setSubmitting(true);
    const res = await deleteAccountAction(data);
    setSubmitting(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    reset();
    toast.success(t.settings.accountDeletedToast);
    // Hard nav so the cleared session cookie is what middleware reads next.
    window.location.href = "/login";
  }

  function onClosed() {
    reset();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClosed} title={t.settings.deleteAccount} size="sm">
      <div className="mb-4 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/[0.06] p-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
        <p className="text-sm text-danger">{t.settings.deleteAccountConfirmDesc}</p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div>
          <label
            htmlFor={pwId}
            className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            {t.settings.passwordConfirm}
          </label>
          <input
            id={pwId}
            type="password"
            autoComplete="current-password"
            aria-invalid={errors.password ? true : undefined}
            {...register("password")}
            className={cn(
              "w-full rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg focus:bg-surface focus:outline-none",
              errors.password
                ? "border-danger/60 focus:border-danger"
                : "border-border focus:border-primary/50"
            )}
          />
          {errors.password && (
            <p className="mt-1.5 text-xs text-danger">{errors.password.message}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClosed}
            className="rounded-full border border-border bg-bg px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-surface-hover"
          >
            {t.settings.cancel}
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-full bg-danger px-4 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-danger/90 disabled:opacity-60"
          >
            {submitting ? t.settings.saving : t.settings.deleteAccountAction}
          </button>
        </div>
      </form>
    </Modal>
  );
}
