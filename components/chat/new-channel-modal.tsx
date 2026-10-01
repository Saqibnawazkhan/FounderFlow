"use client";

/**
 * <NewChannelModal> — the form that finally reaches `createChannelAction`.
 *
 * The action shipped complete and correct and then sat unreachable: chat went
 * out with no "+" anywhere, so the only channels a workspace could ever have
 * were the ones the seed wrote. This modal is the missing caller, and nothing
 * more — every rule about who may create a channel, how the slug is
 * de-collided and what happens on a name race already lives in the action.
 *
 * Form idiom is lifted from app/(app)/projects/new-project-modal.tsx: <Modal>,
 * react-hook-form + zodResolver over the SAME schema the action parses, a local
 * Field/inputClass pair at the bottom, useId() per field. Sharing
 * NewChannelSchema between the two sides is the point — a rule can't drift out
 * of step with itself, and the client rejects a 61-character name for exactly
 * the reason the server would.
 *
 * Strings are plain English rather than useT(): lib/i18n/strings.ts has no chat
 * namespace yet (only nav.chat), and inventing keys here would fork a namespace
 * another workstream owns.
 */

import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import toast from "react-hot-toast";
import { Hash, Lock, Plus } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { createChannelAction } from "@/lib/actions/chat";
import {
  CREATABLE_CHANNEL_KINDS,
  NewChannelSchema,
  type NewChannelInput,
} from "@/lib/schemas/chat";
import { conversationTitle } from "@/lib/chat/dm";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (slug: string) => void;
};

/**
 * Derived from the schema rather than spelled out, so this map is keyed by
 * whatever `CREATABLE_CHANNEL_KINDS` currently holds. Widening that tuple
 * (say, an "announce" kind) breaks this Record at compile time instead of
 * shipping a kind the picker silently refuses to offer — which is the failure
 * this file exists to stop repeating.
 */
type CreatableKind = NewChannelInput["kind"];

const KIND_COPY: Record<
  CreatableKind,
  { label: string; hint: string; Icon: typeof Hash; iconLabel: string }
> = {
  public: {
    label: "Public",
    hint: "Anyone in the workspace can read and post",
    Icon: Hash,
    iconLabel: "Public channel",
  },
  private: {
    label: "Private",
    hint: "Only people you add can see this channel",
    Icon: Lock,
    iconLabel: "Private channel",
  },
};

const EMPTY: NewChannelInput = { name: "", kind: "public", topic: "" };

export function NewChannelModal({ open, onClose, onCreated }: Props) {
  const nameId = useId();
  const kindId = useId();
  const topicId = useId();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    setValue,
    reset,
  } = useForm<NewChannelInput>({
    resolver: zodResolver(NewChannelSchema),
    // "public" by default because a workplace channel is a shared surface
    // unless someone deliberately says otherwise; defaulting to private would
    // quietly build a workspace nobody can find their way around.
    defaultValues: EMPTY,
  });

  const selectedKind = watch("kind");

  // Closing is a deliberate abandon, so the next open starts clean rather than
  // resurrecting a half-typed channel from an hour ago. This is NOT the same
  // gesture as a failed submit below — see the comment there.
  function onClosed() {
    reset(EMPTY);
    onClose();
  }

  async function onSubmit(data: NewChannelInput) {
    setSubmitting(true);
    const res = await createChannelAction(data);
    setSubmitting(false);
    if (!res.success) {
      // Surface the error and leave every field exactly as typed. Wiping
      // someone's input because the server said "a channel with that name
      // already exists" punishes them for a one-word fix, and the retry is
      // usually a single keystroke away.
      toast.error(res.error);
      return;
    }
    // `conversationTitle`, so the confirmation addresses the room the way every
    // other surface will: `#general` for a public one, a bare `pvt-hiring` for a
    // private one. Hashing it here told the creator their private channel was a
    // public room in the same breath as creating it.
    toast.success(`${conversationTitle(data.kind, data.name)} created`);
    reset(EMPTY);
    onCreated(res.data.slug);
  }

  return (
    <Modal open={open} onClose={onClosed} title="New channel" size="md">
      {/* noValidate: zod owns validation. Without it the browser's own
          required/maxlength bubbles fire first and say something different
          from the schema the server enforces. */}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <Field id={nameId} label="Name" error={errors.name?.message}>
          <input
            id={nameId}
            {...register("name")}
            className={inputClass(!!errors.name)}
            placeholder="growth"
            autoComplete="off"
          />
        </Field>

        <div>
          <p
            id={`${kindId}-label`}
            className="mb-1.5 block font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-fg-muted"
          >
            Type
          </p>
          <div
            role="radiogroup"
            aria-labelledby={`${kindId}-label`}
            className="grid gap-2 sm:grid-cols-2"
          >
            {CREATABLE_CHANNEL_KINDS.map((kind) => {
              const { label, hint, Icon, iconLabel } = KIND_COPY[kind];
              const active = selectedKind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setValue("kind", kind, { shouldValidate: true })}
                  className={cn(
                    "rounded-xl border p-3 text-left transition-colors",
                    active
                      ? "border-primary bg-primary/10"
                      : "border-border bg-bg hover:border-fg/30 hover:bg-surface-hover"
                  )}
                >
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-fg">
                    <Icon
                      role="img"
                      aria-label={iconLabel}
                      className={cn("h-3.5 w-3.5 shrink-0", active && "text-primary-strong")}
                    />
                    {label}
                  </span>
                  <span className="mt-1 block text-xs text-fg-muted">{hint}</span>
                </button>
              );
            })}
          </div>
          {errors.kind?.message && (
            <p id={`${kindId}-err`} className="mt-1.5 text-xs text-danger">
              {errors.kind.message}
            </p>
          )}
        </div>

        <Field id={topicId} label="Topic" error={errors.topic?.message}>
          <input
            id={topicId}
            {...register("topic")}
            className={inputClass(!!errors.topic)}
            placeholder="What's this channel for?"
            autoComplete="off"
          />
        </Field>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClosed}
            className="rounded-full border border-border px-4 py-2 text-sm font-medium text-fg-muted transition hover:bg-surface-hover hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-fg transition-transform hover:scale-[1.01] active:scale-95 disabled:opacity-60"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {submitting ? "Creating…" : "Create channel"}
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
