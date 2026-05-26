"use client";

/**
 * Change-supervisor modal. Admin/cofounder only — server action re-verifies.
 */

import { useId, useState } from "react";
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
    formState: { errors },
  } = useForm<ChangeSupervisorInput>({
    resolver: zodResolver(ChangeSupervisorSchema),
    defaultValues: {
      projectId: project.id,
      supervisorId: project.supervisorId,
    },
  });

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
