"use client";

/**
 * Edit company info — name, industry, currency. Server action enforces
 * admin/cofounder; this modal is only rendered when the section is visible,
 * so a member would never reach the trigger.
 */

import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { Save } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { updateCompanyAction } from "@/lib/actions/company";
import {
  SUPPORTED_CURRENCIES,
  UpdateCompanySchema,
  type UpdateCompanyInput,
} from "@/lib/schemas/company";
import { useT } from "@/lib/i18n/use-t";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  defaultName: string;
  defaultIndustry: string;
  defaultCurrency: string;
  onSaved: () => void;
};

export function EditCompanyModal({
  open,
  onClose,
  defaultName,
  defaultIndustry,
  defaultCurrency,
  onSaved,
}: Props) {
  const t = useT();
  const nameId = useId();
  const industryId = useId();
  const currencyId = useId();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<UpdateCompanyInput>({
    resolver: zodResolver(UpdateCompanySchema),
    defaultValues: {
      name: defaultName,
      industry: defaultIndustry,
      // Default to the existing currency if it's a known one, otherwise PKR.
      currency: (SUPPORTED_CURRENCIES as readonly string[]).includes(defaultCurrency)
        ? (defaultCurrency as UpdateCompanyInput["currency"])
        : "PKR",
    },
  });

  function onClosed() {
    reset({
      name: defaultName,
      industry: defaultIndustry,
      currency: (SUPPORTED_CURRENCIES as readonly string[]).includes(defaultCurrency)
        ? (defaultCurrency as UpdateCompanyInput["currency"])
        : "PKR",
    });
    onClose();
  }

  async function onSubmit(data: UpdateCompanyInput) {
    setSubmitting(true);
    const res = await updateCompanyAction(data);
    setSubmitting(false);
    if (!res.success) {
      toast.error(res.error);
      return;
    }
    toast.success(t.settings.companySaved);
    onSaved();
  }

  return (
    <Modal
      open={open}
      onClose={onClosed}
      title={t.settings.editCompany}
      description={t.settings.companyEditNoteAdmin}
      size="md"
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Field
          id={nameId}
          label={t.settings.name}
          error={errors.name?.message}
          inputProps={register("name")}
        />
        <Field
          id={industryId}
          label={t.settings.industryLabel}
          error={errors.industry?.message}
          inputProps={register("industry")}
        />
        <div>
          <label
            htmlFor={currencyId}
            className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            {t.settings.currency}
          </label>
          <select
            id={currencyId}
            {...register("currency")}
            className={cn(
              "w-full appearance-none rounded-xl border bg-bg px-4 py-2.5 text-sm text-fg focus:bg-surface focus:outline-none",
              errors.currency
                ? "border-danger/60 focus:border-danger"
                : "border-border focus:border-primary/50"
            )}
          >
            {SUPPORTED_CURRENCIES.map((c) => (
              <option key={c} value={c} className="bg-bg">
                {c}
              </option>
            ))}
          </select>
          {errors.currency && (
            <p className="mt-1.5 text-xs text-danger">{errors.currency.message}</p>
          )}
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
  error,
  inputProps,
}: {
  id: string;
  label: string;
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
