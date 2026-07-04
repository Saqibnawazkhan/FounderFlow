"use client";

/**
 * Profile edit — name + email. RHF + zod resolver so the server schema is
 * the single source of truth. Email collisions surface as a server error
 * after the form passes client validation.
 */

import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { Save } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { updateProfileAction } from "@/lib/actions/profile";
import { UpdateProfileSchema, type UpdateProfileInput } from "@/lib/schemas/profile";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  defaultName: string;
  defaultEmail: string;
  onSaved: () => void;
};

export function EditProfileModal({ open, onClose, defaultName, defaultEmail, onSaved }: Props) {
  const t = useT();
  const nameId = useId();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<UpdateProfileInput>({
    resolver: zodResolver(UpdateProfileSchema),
    defaultValues: { name: defaultName },
  });

  // Re-seed when the parent re-opens with a possibly-changed profile
  // (e.g. after the user just saved).
  function onClosed() {
    reset({ name: defaultName });
    onClose();
  }

  async function onSubmit(data: UpdateProfileInput) {
    setSubmitting(true);
    const res = await updateProfileAction(data);
    setSubmitting(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(t.settings.profileSaved);
    onSaved();
  }

  return (
    <Modal open={open} onClose={onClosed} title={t.settings.editProfile} size="md">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Field
          id={nameId}
          label={t.settings.name}
          error={errors.name?.message}
          inputProps={register("name")}
        />
        {/* Email is read-only here — changing it goes through the verified
            "Change email" flow (Settings → Profile) so a typo can't lock the
            user out of their own account. */}
        <div>
          <p className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted">
            {t.auth.email}
          </p>
          <p className="rounded-xl border border-border bg-bg/40 px-4 py-2.5 text-sm text-fg-muted">
            {defaultEmail}
          </p>
        </div>
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
  type = "text",
  autoComplete,
  error,
  inputProps,
}: {
  id: string;
  label: string;
  type?: string;
  autoComplete?: string;
  error?: string;
  inputProps: React.InputHTMLAttributes<HTMLInputElement> & {
    name: string;
    ref: React.Ref<HTMLInputElement>;
  };
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        {...inputProps}
        className={cn(
          "w-full rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg focus:bg-surface focus:outline-none",
          error ? "border-danger/60 focus:border-danger" : "border-border focus:border-primary/50"
        )}
      />
      {error && (
        <p id={`${id}-err`} className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
