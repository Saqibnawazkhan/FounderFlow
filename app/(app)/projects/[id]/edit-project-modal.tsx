"use client";

/**
 * Edit project — name, description, color, status, target end date.
 * Supervisor stays in its own modal because reassigning is a
 * heavier-permission action (admin/cofounder only).
 */

import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { Save } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { updateProjectAction } from "@/lib/actions/projects";
import {
  PROJECT_COLORS,
  PROJECT_STATUSES,
  UpdateProjectSchema,
  type UpdateProjectInput,
  type ProjectColor,
} from "@/lib/schemas/project";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";
import type { ProjectClient } from "@/lib/queries/projects";

type Props = {
  open: boolean;
  onClose: () => void;
  project: ProjectClient;
  onSaved: () => void;
};

const SWATCH_CLASSES: Record<ProjectColor, string> = {
  primary: "bg-primary",
  cyan: "bg-cyan",
  pink: "bg-pink",
  warning: "bg-warning",
  info: "bg-info",
};

function toLocalDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function EditProjectModal({ open, onClose, project, onSaved }: Props) {
  const t = useT();
  const nameId = useId();
  const descId = useId();
  const statusId = useId();
  const dateId = useId();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    setValue,
    reset,
  } = useForm<UpdateProjectInput>({
    resolver: zodResolver(UpdateProjectSchema),
    defaultValues: {
      projectId: project.id,
      name: project.name,
      description: project.description ?? "",
      color: project.color as ProjectColor,
      status: project.status,
      // Seed as the yyyy-mm-dd string the <input type="date"> expects.
      // The setValueAs on the register() call coerces back to null on
      // empty + zod's z.coerce.date handles the string → Date hop at
      // parse time. Seeding `new Date(...)` here would mismatch the
      // controlled input and render blank on mount.
      targetEndDate: toLocalDateInput(project.targetEndDate) as unknown as Date | null,
    },
  });

  const selectedColor = watch("color");

  function onClosed() {
    reset({
      projectId: project.id,
      name: project.name,
      description: project.description ?? "",
      color: project.color as ProjectColor,
      status: project.status,
      targetEndDate: toLocalDateInput(project.targetEndDate) as unknown as Date | null,
    });
    onClose();
  }

  async function onSubmit(data: UpdateProjectInput) {
    setSubmitting(true);
    const res = await updateProjectAction(data);
    setSubmitting(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(t.projects.projectSavedToast);
    onSaved();
  }

  return (
    <Modal open={open} onClose={onClosed} title={t.projects.editProject} size="md">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Field id={nameId} label={t.projects.name} error={errors.name?.message}>
          <input id={nameId} {...register("name")} className={inputClass(!!errors.name)} />
        </Field>

        <Field id={descId} label={t.projects.description} error={errors.description?.message}>
          <textarea
            id={descId}
            {...register("description")}
            rows={2}
            className={cn(inputClass(!!errors.description), "resize-y")}
          />
        </Field>

        <Field id={statusId} label={t.projects.status} error={errors.status?.message}>
          <select id={statusId} {...register("status")} className={inputClass(!!errors.status)}>
            {PROJECT_STATUSES.map((s) => {
              const key = `status${s.charAt(0).toUpperCase()}${s.slice(1).replace("_", "")}` as
                | "statusActive"
                | "statusOnHold"
                | "statusCompleted"
                | "statusArchived";
              return (
                <option key={s} value={s} className="bg-bg">
                  {t.projects[key]}
                </option>
              );
            })}
          </select>
        </Field>

        <div>
          <p
            className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
            id={`${nameId}-color`}
          >
            {t.projects.color}
          </p>
          <div role="radiogroup" aria-labelledby={`${nameId}-color`} className="flex gap-2">
            {PROJECT_COLORS.map((c) => {
              const active = selectedColor === c;
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={c}
                  onClick={() => setValue("color", c, { shouldValidate: true })}
                  className={cn(
                    "h-9 w-9 rounded-xl border-2 transition-all",
                    SWATCH_CLASSES[c],
                    active ? "border-fg ring-2 ring-fg/40" : "border-transparent hover:border-fg/30"
                  )}
                />
              );
            })}
          </div>
        </div>

        <Field
          id={dateId}
          label={t.projects.targetEndDate}
          error={errors.targetEndDate?.message as string | undefined}
        >
          <input
            id={dateId}
            type="date"
            defaultValue={toLocalDateInput(project.targetEndDate)}
            // See new-project-modal — empty "" must become null so the
            // zod resolver doesn't reject the whole form silently.
            {...register("targetEndDate", {
              setValueAs: (v: unknown) => (v === "" || v === undefined ? null : v),
            })}
            className={inputClass(!!errors.targetEndDate)}
          />
        </Field>

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
            <Save className="h-4 w-4" aria-hidden="true" />
            {submitting ? t.settings.saving : t.settings.saveChanges}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
      >
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-err`} className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function inputClass(hasError: boolean) {
  return cn(
    "w-full appearance-none rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg focus:bg-surface focus:outline-none",
    hasError ? "border-danger/60 focus:border-danger" : "border-border focus:border-primary/50"
  );
}
