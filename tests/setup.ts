/**
 * Vitest global setup. Loaded before any test file.
 *
 * Adds @testing-library/jest-dom matchers (toBeInTheDocument, toHaveAttribute,
 * etc.) and stubs browser APIs that jsdom doesn't implement but our components
 * touch (matchMedia, scrollTo, ResizeObserver).
 */

import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// React Testing Library doesn't auto-cleanup with Vitest globals — do it here.
afterEach(() => {
  cleanup();
});

// Radix Dialog calls these on mount; jsdom doesn't ship them.
if (typeof window !== "undefined") {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  // Radix Dialog uses ResizeObserver to size the content.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Radix Dialog uses these for focus management.
  Element.prototype.hasPointerCapture =
    vi.fn() as unknown as typeof Element.prototype.hasPointerCapture;
  Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
}
