"use client";

/**
 * Change password — three fields, server re-verifies the current password
 * with bcrypt before writing. We don't sign the user out on success — JWT
 * sessions stay valid until the cookie expires.
 */

import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { Eye, EyeOff, Save } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { changePasswordAction } from "@/lib/actions/profile";
import { ChangePasswordSchema, type ChangePasswordInput } from "@/lib/schemas/profile";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function ChangePasswordModal({ open, onClose }: Props) {
  const t = useT();
  const curId = useId();
  const newId = useId();
  const confirmId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<ChangePasswordInput>({
    resolver: zodResolver(ChangePasswordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  function onClosed() {
    reset();
    setShowCurrent(false);
    setShowNext(false);
    onClose();
  }

  async function onSubmit(data: ChangePasswordInput) {
    setSubmitting(true);
    const res = await changePasswordAction(data);
    setSubmitting(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(t.settings.passwordChanged);
    onClosed();
  }

  return (
    <Modal open={open} onClose={onClosed} title={t.settings.changePassword} size="md">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <PasswordField
          id={curId}
          label={t.settings.currentPassword}
          autoComplete="current-password"
          show={showCurrent}
          onToggleShow={() => setShowCurrent((s) => !s)}
          showLabel={t.auth.showPassword}
          hideLabel={t.auth.hidePassword}
          error={errors.currentPassword?.message}
          inputProps={register("currentPassword")}
        />
        <PasswordField
          id={newId}
          label={t.settings.newPassword}
          autoComplete="new-password"
          show={showNext}
          onToggleShow={() => setShowNext((s) => !s)}
          showLabel={t.auth.showPassword}
          hideLabel={t.auth.hidePassword}
          error={errors.newPassword?.message}
          inputProps={register("newPassword")}
        />
        <PasswordField
          id={confirmId}
          label={t.settings.confirmPassword}
          autoComplete="new-password"
          show={showNext}
          onToggleShow={() => setShowNext((s) => !s)}
          showLabel={t.auth.showPassword}
          hideLabel={t.auth.hidePassword}
          error={errors.confirmPassword?.message}
          inputProps={register("confirmPassword")}
        />
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

function PasswordField({
  id,
  label,
  autoComplete,
  show,
  onToggleShow,
  showLabel,
  hideLabel,
  error,
  inputProps,
}: {
  id: string;
  label: string;
  autoComplete: string;
  show: boolean;
  onToggleShow: () => void;
  showLabel: string;
  hideLabel: string;
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
      <div className="relative">
        <input
          id={id}
          type={show ? "text" : "password"}
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          {...inputProps}
          className={cn(
            "w-full rounded-xl border bg-bg px-4 py-2.5 pr-11 text-sm text-fg focus:bg-surface focus:outline-none",
            error ? "border-danger/60 focus:border-danger" : "border-border focus:border-primary/50"
          )}
        />
        <button
          type="button"
          onClick={onToggleShow}
          aria-label={show ? hideLabel : showLabel}
          className="absolute right-2.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-glass/[0.06] hover:text-fg"
        >
          {show ? (
            <EyeOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Eye className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
      {error && (
        <p id={`${id}-err`} className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
