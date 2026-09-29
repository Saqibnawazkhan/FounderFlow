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
  /**
   * acct-018. Whether this reader can reach the WORKSPACE export card in Data &
   * storage (`canSeeFinances`). Passed in rather than derived here: the finance
   * gate lives on the settings page, and `deletesWorkspace` below is computed
   * from the live member count alone and never consults the role, so the two
   * questions are genuinely independent.
   */
  canExportWorkspace: boolean;
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

export function DeleteAccountModal({ open, onClose, canExportWorkspace }: Props) {
  const t = useT();
  const pwId = useId();
  const nameId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [scope, setScope] = useState<{
    deletesWorkspace: boolean;
    workspaceName: string;
  } | null>(null);
  const [scopeLoaded, setScopeLoaded] = useState(false);
  /**
   * The server's refusal, kept on the screen rather than only in a toast.
   *
   * The toaster's duration is 3500ms (components/providers.tsx), and the refusal
   * this dialog is most likely to receive is the sole-founder gate's — 150
   * characters that name the workspace and ask the reader to type it
   * (lib/actions/account.ts:135). That is an instruction, and it is the recovery
   * route for a failed scope lookup: with the scope unknown there is no name field
   * on this screen, so the way forward is to read the sentence, close, and reopen
   * (which re-asks). A sentence that has already faded makes that unguessable.
   * The toast still fires — it is what pulls the eye back to a dialog the reader
   * may have scrolled away from.
   */
  const [deleteError, setDeleteError] = useState<string | null>(null);
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

  /**
   * acct-018 — "download your data first", said honestly.
   *
   * THE TRAP THIS BRANCH EXISTS FOR. `?scope=me` never queries Transaction,
   * Budget or RecurringRule in any role (app/api/export/route.ts: money belongs
   * to the workspace, not to a person), and the sole-founder branch of
   * `deleteAccountAction` destroys all three. So one undifferentiated "export
   * first" line would hand a solo founder a file with none of their ledger in it
   * and tell them it was their data. This modal is the only place that knows
   * which of the two destructions this is, so it is the only place that can pick
   * the right file.
   *
   * `null` in the remaining case — a whole-workspace delete by someone who cannot
   * reach the workspace export — is deliberate. Today that case should not arise
   * (the last live user is always an admin: `removeUserAction` refuses to remove
   * the last admin or the caller themselves, and the multi-user branch here
   * refuses a sole admin's self-delete), but the copy must not depend on that
   * invariant holding. Saying nothing is the pre-existing behaviour; pointing at a
   * card that is not on their screen, or at a personal file that omits exactly
   * what is about to be destroyed, would both be worse than silence.
   *
   * Nothing at all until `scopeLoaded`, for the same reason the submit button is
   * disabled until then: `deletesWorkspace` reads false while the answer is in
   * flight, so an ungated hint would show a solo founder the personal-file line
   * first and then swap it — one frame of precisely the wrong sentence.
   *
   * AND NOTHING WHEN THE LOOKUP FAILED, which is why this reads `scope` and not
   * `deletesWorkspace`. `scope` is null in two unrelated situations — "not asked
   * yet" and "asked, and `describeAccountDeletionAction` returned !success" — and
   * only the first is covered by `scopeLoaded`. On a failure the second branch
   * used to fall through to the PERSONAL line and state, as fact, the exact lie
   * the branch above exists to prevent: a sole founder whose lookup failed was
   * told to take "Download my data", the one file that provably does not contain
   * the transactions, budgets and recurring rules this click destroys. Silence is
   * the honest answer to a destruction whose size we do not know; the narrower of
   * two claims is not. (The delete itself still fails closed — the sole-user
   * branch re-checks the typed workspace name server-side,
   * lib/actions/account.ts:132 — so what was at stake here was the reassurance,
   * not the rows.)
   */
  const exportHint =
    !scopeLoaded || !scope
      ? null
      : scope.deletesWorkspace
        ? canExportWorkspace
          ? t.settings.exportBeforeWorkspaceDeleteHint
          : null
        : t.settings.exportBeforeAccountDeleteHint;

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
    // Cleared before the attempt: a refusal left under a fresh submission reads as
    // a second failure.
    setDeleteError(null);
    const res = await deleteAccountAction(
      deletesWorkspace
        ? { password: data.password, workspaceName: data.workspaceName }
        : { password: data.password }
    );
    setSubmitting(false);
    if (!res.success) {
      setDeleteError(res.error);
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
    setDeleteError(null);
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

      {/* acct-018. Outside the danger-red alert on purpose: taking a copy is the
          harmless, reversible half of this screen, and acct-007 is this page's own
          record of what happened when a harmless action was dressed in red. */}
      {exportHint && <p className="mb-4 text-xs text-fg-muted">{exportHint}</p>}

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

        {/* Same shape as app/forgot-password/page.tsx:198 — role="alert" so a
            screen reader is told, and inside the dialog so the instruction is
            still there after the toast has gone. */}
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
