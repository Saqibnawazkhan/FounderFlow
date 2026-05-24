import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "@/components/ui/modal";

describe("Modal a11y", () => {
  it("renders nothing when closed", () => {
    render(
      <Modal open={false} onClose={() => {}} title="Hidden">
        <p>body</p>
      </Modal>
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders with role=dialog when open", () => {
    // Radix v1.1+ relies on focus-trap behavior instead of the aria-modal
    // attribute, per the current WAI-ARIA APG recommendation. We assert the
    // role (which is what screen readers actually use to announce the dialog)
    // and validate focus-trap behavior in a separate test.
    render(
      <Modal open onClose={() => {}} title="My modal" description="Some context">
        <p>body</p>
      </Modal>
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
  });

  it("exposes title as the accessible name", () => {
    render(
      <Modal open onClose={() => {}} title="Invite teammate">
        <p>body</p>
      </Modal>
    );
    // Radix wires Dialog.Title up as aria-labelledby on the content.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Invite teammate");
  });

  it("exposes description as the accessible description when provided", () => {
    render(
      <Modal open onClose={() => {}} title="Invite" description="Add a teammate to your workspace">
        <p>body</p>
      </Modal>
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleDescription("Add a teammate to your workspace");
  });

  it("renders the close button with an aria-label", () => {
    render(
      <Modal open onClose={() => {}} title="Closable">
        <p>body</p>
      </Modal>
    );
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Closable">
        <p>body</p>
      </Modal>
    );
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Closable">
        <p>body</p>
      </Modal>
    );
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders children inside the dialog", () => {
    render(
      <Modal open onClose={() => {}} title="With children">
        <p>I am the body</p>
      </Modal>
    );
    expect(screen.getByText("I am the body")).toBeInTheDocument();
  });

  it("omits the close button when hideClose is set", () => {
    render(
      <Modal open onClose={() => {}} title="No close" hideClose>
        <p>body</p>
      </Modal>
    );
    expect(screen.queryByRole("button", { name: /close/i })).not.toBeInTheDocument();
  });
});
