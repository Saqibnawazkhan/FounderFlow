"use client";

/**
 * <CommentThreadModal> — wraps <CommentThread> in a Modal and lazy-loads the
 * conversation on open. Callers wire it to a per-row "💬 N" button and pass
 * the target (taskId or transactionId).
 *
 * State machine:
 *   open=false           → nothing rendered
 *   open=true, loading=true  → spinner
 *   open=true, error         → retry button
 *   open=true, loaded        → <CommentThread>
 *
 * The host page is responsible for triggering router.refresh() (via the
 * onChanged callback) after writes so the row's comment-count badge stays
 * accurate.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { Modal } from "@/components/ui/modal";
import { listCommentsAction } from "@/lib/actions/comments";
import { CommentThread } from "./comment-thread";
import type { CommentClient, CommentTarget } from "@/lib/queries/comments";
import type { MentionUser } from "@/lib/comments/mentions";

type Props = {
  open: boolean;
  onClose: () => void;
  target: CommentTarget;
  /** Human label for the modal header ("Task: Ship pricing page"). */
  title: string;
  description?: string;
  currentUserId: string;
  currentUserRole: "admin" | "cofounder" | "member";
  companyUsers: MentionUser[];
  onChanged?: () => void;
};

export function CommentThreadModal({
  open,
  onClose,
  target,
  title,
  description,
  currentUserId,
  currentUserRole,
  companyUsers,
  onChanged,
}: Props) {
  const [comments, setComments] = useState<CommentClient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Stable key for the target so the load-effect only re-fires when the
  // identity actually changes, not on every parent render.
  const targetKey = "taskId" in target ? `task:${target.taskId}` : `txn:${target.transactionId}`;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setComments(null);
    setError(null);
    listCommentsAction(target).then((res) => {
      if (cancelled) return;
      if (res.success) setComments(res.data);
      else setError(res.error);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetKey]);

  async function refresh() {
    onChanged?.();
    const res = await listCommentsAction(target);
    if (res.success) setComments(res.data);
    else toast.error(res.error);
  }

  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size="lg">
      {error ? (
        <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
          {error}
        </div>
      ) : comments === null ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading conversation…
        </div>
      ) : (
        <CommentThread
          target={target}
          initialComments={comments}
          currentUserId={currentUserId}
          currentUserRole={currentUserRole}
          companyUsers={companyUsers}
          onChanged={refresh}
        />
      )}
    </Modal>
  );
}
