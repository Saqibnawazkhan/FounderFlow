/**
 * Zod schemas for comment mutations. XOR enforcement on the discriminator
 * happens here (exactly one of taskId / transactionId must be set) so the
 * server action can just `parse()` and trust the result.
 */

import { z } from "zod";

const BodySchema = z
  .string()
  .trim()
  .min(1, "Comment can't be empty")
  .max(2000, "Keep it under 2,000 characters");

export const NewCommentSchema = z
  .object({
    body: BodySchema,
    taskId: z.string().min(1).optional(),
    transactionId: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.taskId) !== Boolean(v.transactionId), {
    message: "Comment must target exactly one of taskId or transactionId",
    path: ["taskId"],
  });

export type NewCommentInput = z.infer<typeof NewCommentSchema>;

export const DeleteCommentSchema = z.object({
  commentId: z.string().min(1),
});

export type DeleteCommentInput = z.infer<typeof DeleteCommentSchema>;
