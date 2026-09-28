"use client";

/**
 * "Delete my account" modal. Re-auths with a password check inside the
 * server action even though the caller already has a session cookie —
 * see [lib/actions/account.ts] for the rationale.
 *
 * TWO DIALOGS IN ONE, and that is the acct-013 fix. `deleteAccountAction`
 * branches on whether anybody else is left in the workspace:
 *
 *   • teammates remain → it tombstones the caller only. One password is the
 *     right amount of friction, and the copy below is about an account.
 *   • the caller is the only member → it runs the BYTE-IDENTICAL
 *     `softDeleteWorkspace` cascade that "Delete this workspace" runs, over
 *     every transaction, budget, task and comment the business has. That is the
 *     shape FounderFlow's stated target user — the solo founder — actually hits,
 *     and it used to go behind one password box and copy whose strongest word
 *     was "account". The word "workspace" did not appear in this modal at all,
 *     so afterwards the user's model was "I removed my login" and they never
 *     asked for the restore that is available for 90 days.
 *
 * So the modal asks the server which case it is (`describeAccountDeletionAction`
 * — the page's props carry the company and the caller, never the member count)
 * and, for the second, demands the same two keys as the workspace delete:
 * the workspace name typed exactly, then the password. The server re-checks the
 * name in the same branch that runs the cascade; this dialog is the friction,
 * not the guarantee.
 *
 * Behaviour on success: the server signs the user out and returns; this
 * component then hard-navigates to /login so middleware sees the cleared
 * cookie on the very next request.
 */

import { useEffect, useId, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertTriangle } from "lucide-react";
import toast from "react-hot-toast";
import { Modal } from "@/components/ui/modal";
import { deleteAccountAction, describeAccountDeletionAction } from "@/lib/actions/account";
import { DeleteAccountSchema } from "@/lib/schemas/account";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * `workspaceName` is optional HERE and required by the action's sole-user branch.
 * It is not added to `DeleteAccountSchema` because the multi-user branch must
 * keep working with a password alone — the field is only rendered, and only
 * demanded, when this delete is about to erase a whole workspace.
 */
const DeleteAccountFormSchema = DeleteAccountSchema.extend({
  workspaceName: z.string().optional(),
});
type DeleteAccountFormValues = z.infer<typeof DeleteAccountFormSchema>;

export function DeleteAccountModal({ open, onClose }: Props) {
  const t = useT();
  const pwId = useId();
  const nameId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [scope, setScope] = useState<{
    deletesWorkspace: boolean;
    workspaceName: string;
  } | null>(null);
  const [scopeLoaded, setScopeLoaded] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<DeleteAccountFormValues>({
    resolver: zodResolver(DeleteAccountFormSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: { password: "", workspaceName: "" },
  });

  // Asked on open rather than on mount: the answer changes when a teammate is
  // invited or deactivated, and a modal that cached "you are not alone" from
  // page load would show the weaker dialog for a workspace that has since become
  // a solo one.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setScopeLoaded(false);
    describeAccountDeletionAction().then((res) => {
      if (cancelled) return;
      setScope(res.success ? res.data : null);
      setScopeLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const deletesWorkspace = scope?.deletesWorkspace === true;

  async function onSubmit(data: DeleteAccountFormValues) {
    if (deletesWorkspace && scope) {
      // Checked here for an instant, in-field answer; the action checks it again
      // because a server action is a POST endpoint and this file is not a gate.
      if ((data.workspaceName ?? "").trim() !== scope.workspaceName.trim()) {
        setError("workspaceName", {
          message: `Type "${scope.workspaceName}" exactly to confirm.`,
        });
        return;
      }
    }
    setSubmitting(true);
    const res = await deleteAccountAction(
      deletesWorkspace
        ? { password: data.password, workspaceName: data.workspaceName }
        : { password: data.password }
    );
    setSubmitting(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    reset();
    toast.success(
      deletesWorkspace ? t.settings.workspaceDeletedToast : t.settings.accountDeletedToast
    );
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
        <p className="text-sm text-danger">
          {deletesWorkspace && scope
            ? t.settings.deleteAccountWorkspaceConfirmDesc.replace(
                "{workspace}",
                `"${scope.workspaceName}"`
              )
            : t.settings.deleteAccountConfirmDesc}
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        {deletesWorkspace && scope && (
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
              placeholder={scope.workspaceName}
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
        )}

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
            // Disabled until the scope is known: submitting before the answer
            // arrives would either ask for no workspace name when one is required
            // (the server refuses, with a confusing error) or show the milder copy
            // for the destructive case, which is the bug this modal is fixing.
            disabled={submitting || !scopeLoaded}
            className="rounded-full bg-danger px-4 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-danger/90 disabled:opacity-60"
          >
            {submitting
              ? t.settings.saving
              : deletesWorkspace
                ? t.settings.deleteAccountAndWorkspaceAction
                : t.settings.deleteAccountAction}
          </button>
        </div>
      </form>
    </Modal>
  );
}
