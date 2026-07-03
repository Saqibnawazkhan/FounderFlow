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
    const res = await deleteWorkspaceAction(data);
    setSubmitting(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    reset();
    toast.success(t.settings.workspaceDeletedToast);
    window.location.href = "/login";
  }

  function onClosed() {
    reset();
    onClose();
  }

  return (
    <Modal open={open} onClose={onClosed} title={t.settings.deleteWorkspace} size="sm">
      <div className="mb-4 flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/[0.06] p-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
        <p className="text-sm text-danger">{t.settings.deleteWorkspaceConfirmDesc}</p>
      </div>

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
