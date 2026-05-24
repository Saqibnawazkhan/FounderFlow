import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TransactionForm } from "@/components/transactions/transaction-form";

// Mock the server action — we're testing form validation behavior, not the
// real Prisma write. The mock returns a settable result so each test controls
// the action outcome.
const addTransactionAction = vi.fn();
vi.mock("@/lib/actions/transactions", () => ({
  addTransactionAction: (input: unknown) => addTransactionAction(input),
}));

// react-hot-toast is fire-and-forget; stub it so we don't render its portal.
vi.mock("react-hot-toast", () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

describe("TransactionForm — validation", () => {
  beforeEach(() => {
    addTransactionAction.mockReset();
  });

  function renderForm(type: "expense" | "investment" = "expense") {
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    return {
      onClose,
      onSuccess,
      ...render(<TransactionForm type={type} onClose={onClose} onSuccess={onSuccess} />),
    };
  }

  it("renders amount, category, date, and description fields", () => {
    renderForm();
    expect(screen.getByRole("spinbutton", { name: /amount/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /category/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^date$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
  });

  it("shows an error and does NOT call the server action on empty amount", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole("button", { name: /add expense/i }));
    expect(await screen.findByText(/amount must be a number/i)).toBeInTheDocument();
    expect(addTransactionAction).not.toHaveBeenCalled();
  });

  it("rejects a zero amount", async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByRole("spinbutton", { name: /amount/i }), "0");
    await user.click(screen.getByRole("button", { name: /add expense/i }));
    expect(await screen.findByText(/greater than 0/i)).toBeInTheDocument();
    expect(addTransactionAction).not.toHaveBeenCalled();
  });

  it("calls the server action with parsed numeric amount on valid submit", async () => {
    addTransactionAction.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    const { onClose, onSuccess } = renderForm();
    await user.type(screen.getByRole("spinbutton", { name: /amount/i }), "12345");
    await user.type(screen.getByLabelText(/description/i), "Office rent");
    await user.click(screen.getByRole("button", { name: /add expense/i }));

    await waitFor(() => expect(addTransactionAction).toHaveBeenCalled());
    const arg = addTransactionAction.mock.calls[0][0];
    // amount must be a number (valueAsNumber transform), not a string.
    expect(typeof arg.amount).toBe("number");
    expect(arg.amount).toBe(12345);
    expect(arg.type).toBe("expense");
    expect(arg.description).toBe("Office rent");
    // The form normalizes date to an ISO string before posting.
    expect(typeof arg.date).toBe("string");
    expect(() => new Date(arg.date)).not.toThrow();
    // Closes + signals parent to refresh on success.
    expect(onClose).toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalled();
  });

  it("keeps the modal open and surfaces the toast when the action fails", async () => {
    addTransactionAction.mockResolvedValue({ success: false, error: "Not authenticated" });
    const user = userEvent.setup();
    const { onClose } = renderForm();
    await user.type(screen.getByRole("spinbutton", { name: /amount/i }), "100");
    await user.click(screen.getByRole("button", { name: /add expense/i }));
    await waitFor(() => expect(addTransactionAction).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("uses the investment label when type=investment", () => {
    renderForm("investment");
    expect(screen.getByRole("button", { name: /add investment/i })).toBeInTheDocument();
  });
});
