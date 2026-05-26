"use client";

/**
 * New project modal. Fields: name, description (optional), supervisor
 * (select from company users), color (swatch picker), optional target end
 * date. RHF + zod resolver so the same schema validates on both sides.
 */

import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { Save } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { createProjectAction } from "@/lib/actions/projects";
import {
  NewProjectSchema,
  PROJECT_COLORS,
  type NewProjectInput,
  type ProjectColor,
} from "@/lib/schemas/project";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";
import type { User } from "@/lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
  users: User[];
  currentUserId: string;
  onCreated: (projectId: string) => void;
};

const SWATCH_CLASSES: Record<ProjectColor, string> = {
  primary: "bg-primary",
  cyan: "bg-cyan",
  pink: "bg-pink",
  warning: "bg-warning",
  info: "bg-info",
};

export function NewProjectModal({ open, onClose, users, currentUserId, onCreated }: Props) {
  const t = useT();
  const nameId = useId();
  const descId = useId();
  const supId = useId();
  const dateId = useId();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    setValue,
    reset,
  } = useForm<NewProjectInput>({
    resolver: zodResolver(NewProjectSchema),
    defaultValues: {
      name: "",
      description: "",
      supervisorId: currentUserId, // default to self — fastest path for "I'm running this"
      color: "primary",
    },
  });

  const selectedColor = watch("color");

  function onClosed() {
    reset({
      name: "",
      description: "",
      supervisorId: currentUserId,
      color: "primary",
    });
    onClose();
  }

  async function onSubmit(data: NewProjectInput) {
    setSubmitting(true);
    const res = await createProjectAction(data);
    setSubmitting(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(t.projects.projectCreatedToast);
    onCreated(res.data.projectId);
  }

  return (
    <Modal open={open} onClose={onClosed} title={t.projects.newProject} size="md">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Field id={nameId} label={t.projects.name} error={errors.name?.message}>
          <input
            id={nameId}
            {...register("name")}
            className={inputClass(!!errors.name)}
            placeholder="Launch v2"
          />
        </Field>

        <Field id={descId} label={t.projects.description} error={errors.description?.message}>
          <textarea
            id={descId}
            {...register("description")}
            rows={2}
            className={cn(inputClass(!!errors.description), "resize-y")}
            placeholder="One-line summary of what this project is for"
          />
        </Field>

        <Field id={supId} label={t.projects.supervisor} error={errors.supervisorId?.message}>
          <select
            id={supId}
            {...register("supervisorId")}
            className={inputClass(!!errors.supervisorId)}
          >
            {users.map((u) => (
              <option key={u.id} value={u.id} className="bg-bg">
                {u.name} {u.id === currentUserId ? "(you)" : ""}
              </option>
            ))}
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
            {...register("targetEndDate")}
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
