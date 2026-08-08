import { describe, it, expect } from "vitest";
import { NewCommentSchema, DeleteCommentSchema } from "@/lib/schemas/comment";

describe("NewCommentSchema", () => {
  it("accepts a comment targeting a task", () => {
    expect(NewCommentSchema.safeParse({ body: "Looks good", taskId: "t1" }).success).toBe(true);
  });

  it("accepts a comment targeting a transaction", () => {
    expect(NewCommentSchema.safeParse({ body: "Refund?", transactionId: "tx1" }).success).toBe(
      true
    );
  });

  it("rejects targeting BOTH a task and a transaction (XOR)", () => {
    const result = NewCommentSchema.safeParse({ body: "hi", taskId: "t1", transactionId: "tx1" });
    expect(result.success).toBe(false);
  });

  it("rejects targeting NEITHER (XOR)", () => {
    expect(NewCommentSchema.safeParse({ body: "orphan comment" }).success).toBe(false);
  });

  it("rejects an empty / whitespace-only body", () => {
    expect(NewCommentSchema.safeParse({ body: "   ", taskId: "t1" }).success).toBe(false);
  });

  it("trims the body before length checks", () => {
    const result = NewCommentSchema.safeParse({ body: "  hello  ", taskId: "t1" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.body).toBe("hello");
  });

  it("caps the body at 2,000 characters", () => {
    expect(NewCommentSchema.safeParse({ body: "x".repeat(2001), taskId: "t1" }).success).toBe(
      false
    );
  });
});

describe("DeleteCommentSchema", () => {
  it("requires a commentId", () => {
    expect(DeleteCommentSchema.safeParse({ commentId: "c1" }).success).toBe(true);
    expect(DeleteCommentSchema.safeParse({ commentId: "" }).success).toBe(false);
  });
});
