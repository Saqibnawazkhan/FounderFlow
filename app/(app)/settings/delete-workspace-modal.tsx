"use client";

/**
 * "Delete this workspace" modal — admin-only. Two-key confirmation:
 * password + typing the workspace name exactly (GitHub / Vercel /
 * Supabase share the same UX for the same reason — the name-match beats
 * accidental muscle-memory clicks on the confirm button).
 */

import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle } from "lucide-react";
import toast from "react-hot-toast";
import { Modal } from "@/components/ui/modal";
import { deleteWorkspaceAction } from "@/lib/actions/account";
import { DeleteWorkspaceSchema, type DeleteWorkspaceInput } from "@/lib/schemas/account";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  workspaceName: string;
};

export function DeleteWorkspaceModal({ open, onClose, workspaceName }: Props) {
  const t = useT();
  const pwId = useId();
  const nameId = useId();
  const [submitting, setSubmitting] = useState(false);
  /**
   * The server's refusal, kept on the screen and not only in a 3500ms toast — the
   * same treatment delete-account-modal.tsx gives its own, because this dialog
   * receives the same class of message. `deleteWorkspaceAction` refuses a delete
   * it cannot bill-cancel with a two-step instruction ("Cancel it in LemonSqueezy
   * first, then delete the workspace", lib/actions/account.ts:376), and an
   * instruction the reader cannot re-read is an instruction they cannot follow.
   * The toast still fires; it is what draws the eye back to the dialog.
   */
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<DeleteWorkspaceInput>({
    resolver: zodResolver(DeleteWorkspaceSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: { password: "", workspaceName: "" },
  });

  async function onSubmit(data: DeleteWorkspaceInput) {
    setSubmitting(true);
    // Cleared before the attempt: a refusal left under a fresh submission reads as
    // a second failure.
    setDeleteError(null);
    const res = await deleteWorkspaceAction(data);
    setSubmitting(false);
    if (!res.success) {
      setDeleteError(res.error);
      toast.error(res.error);
      return;
    }
    reset();
    toast.success(t.settings.workspaceDeletedToast);
    window.location.href = "/login";
  }

  function onClosed() {
    reset();
    setDeleteError(null);
    onClose();
  }

  return (
    <Modal open={open} onClose={onClosed} title={t.settings.deleteWorkspace} size="sm">
      <div className="mb-4 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/[0.06] p-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
        <p className="text-sm text-danger">{t.settings.deleteWorkspaceConfirmDesc}</p>
      </div>

      {/* acct-018. The same warning the sole-founder branch of the account dialog
          carries, because this destroys the identical rows: "Download my data"
          (?scope=me) never contains Transaction, Budget or RecurringRule, so the
          only file that survives this click with the ledger in it is the workspace
          export. This dialog is admin-only, so that card is always reachable from
          here. Outside the red alert — taking a copy destroys nothing (acct-007). */}
      <p className="mb-4 text-xs text-fg-muted">{t.settings.exportBeforeWorkspaceDeleteHint}</p>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div>
          <label
            htmlFor={nameId}
            className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            {t.settings.workspaceNameConfirm}
          </label>
          <input
            id={nameId}
            type="text"
            autoComplete="off"
            placeholder={workspaceName}
            aria-invalid={errors.workspaceName ? true : undefined}
            {...register("workspaceName")}
            className={cn(
              "w-full rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg placeholder:text-fg-muted/60 focus:bg-surface focus:outline-none",
              errors.workspaceName
                ? "border-danger/60 focus:border-danger"
                : "border-border focus:border-primary/50"
            )}
          />
          {errors.workspaceName && (
            <p className="mt-1.5 text-xs text-danger">{errors.workspaceName.message}</p>
          )}
        </div>

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

        {/* role="alert", same shape as app/forgot-password/page.tsx:198. */}
        {deleteError && (
          <p role="alert" className="text-xs font-medium text-danger">
            {deleteError}
          </p>
        )}

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
            {submitting ? t.settings.saving : t.settings.deleteWorkspaceAction}
          </button>
        </div>
      </form>
    </Modal>
  );
}
