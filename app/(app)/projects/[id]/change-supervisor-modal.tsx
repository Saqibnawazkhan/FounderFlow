"use client";

/**
 * Change-supervisor modal. Admin/cofounder only — server action re-verifies.
 */

import { useEffect, useId, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { Save } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { changeSupervisorAction } from "@/lib/actions/projects";
import { ChangeSupervisorSchema, type ChangeSupervisorInput } from "@/lib/schemas/project";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";
import type { ProjectClient } from "@/lib/queries/projects";
import type { User } from "@/lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
  project: ProjectClient;
  users: User[];
  onSaved: () => void;
};

export function ChangeSupervisorModal({ open, onClose, project, users, onSaved }: Props) {
  const t = useT();
  const supId = useId();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ChangeSupervisorInput>({
    resolver: zodResolver(ChangeSupervisorSchema),
    defaultValues: {
      projectId: project.id,
      supervisorId: project.supervisorId,
    },
  });

  /**
   * RESEED ON OPEN — projects-008, and the same defect EditProjectModal was
   * fixed for. Worse here, because this form has one field: a stale value is not
   * a stale detail, it is the whole instruction.
   *
   * project-detail-client.tsx mounts this component for the page's whole
   * lifetime (`{canReassign && <ChangeSupervisorModal open={supOpen} … />}`), so
   * `useForm` above runs ONCE, at page load, and `defaultValues` is a snapshot
   * from then. Radix unmounts the dialog's DOM on close but react-hook-form's
   * state lives up here and survives it, and the parent's `onSaved` calls
   * `router.refresh()` without remounting or resetting — so after a successful
   * reassignment the `<select>` still carried the PREVIOUS supervisor's id.
   *
   * That was not merely cosmetic. `onSubmit` returns early when the chosen id
   * equals `project.supervisorId`, and the prop is by then the NEW id while the
   * form holds the OLD one — so they differ, the no-op guard reads the stale
   * value as a deliberate change, and one press of Save handed the project back
   * to the person it had just been taken from, with a second notification to the
   * wrong person and an activity row narrating it.
   *
   * Only on the false→true transition, for the reason EditProjectModal gives:
   * reseeding on every `project` change would discard a half-made choice the
   * moment anything else on the page fired a refresh with the dialog open.
   */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      reset({ projectId: project.id, supervisorId: project.supervisorId });
    }
    wasOpen.current = open;
  }, [open, project.id, project.supervisorId, reset]);

  async function onSubmit(data: ChangeSupervisorInput) {
    if (data.supervisorId === project.supervisorId) {
      onClose();
      return;
    }
    setSubmitting(true);
    const res = await changeSupervisorAction(data);
    setSubmitting(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(t.projects.supervisorChangedToast);
    onSaved();
  }

  return (
    <Modal open={open} onClose={onClose} title={t.projects.changeSupervisor} size="sm">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <div>
          <label
            htmlFor={supId}
            className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            {t.projects.supervisor}
          </label>
          <select
            id={supId}
            {...register("supervisorId")}
            className={cn(
              "w-full appearance-none rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg focus:bg-surface focus:outline-none",
              errors.supervisorId
                ? "border-danger/60 focus:border-danger"
                : "border-border focus:border-primary/50"
            )}
          >
            {users.map((u) => (
              <option key={u.id} value={u.id} className="bg-bg">
                {u.name}
              </option>
            ))}
          </select>
          {errors.supervisorId && (
            <p className="mt-1.5 text-xs text-danger">{errors.supervisorId.message}</p>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border px-4 py-2 text-sm font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
          >
            {t.settings.cancel}
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60"
          >
            <Save className="h-4 w-4" aria-hidden="true" />
            {submitting ? t.settings.saving : t.settings.saveChanges}
          </button>
        </div>
      </form>
    </Modal>
  );
}
