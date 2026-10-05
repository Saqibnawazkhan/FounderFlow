/**
 * The /dashboard announcement banner — channel 1 of the "just got cooler"
 * announcement, and the one that actually reaches people. Push needs a granted
 * permission AND a live PushSubscription row; the banner needs the user to open
 * the app.
 *
 * Four properties, each of which is a way this could go wrong in public:
 *
 *   1. NO FLASH. The banner must contribute nothing to the first paint, because
 *      the first paint happens on the server and the server cannot know whether
 *      this browser already dismissed it. Asserted against
 *      `renderToStaticMarkup` — the actual markup the server sends — rather
 *      than against a mocked hook, so the property is checked where it holds.
 *   2. ONE-TIME. Once dismissed it must stay gone across a remount, which is
 *      what a navigation or a refresh is.
 *   3. STORAGE MAY THROW. `localStorage` raises in a private window and can be
 *      blocked outright. Every read and write is wrapped, and the banner must
 *      still render and still dismiss (for the life of the page) when it is
 *      unavailable — failing OPEN, because the cost of showing a cosmetic
 *      banner twice is nothing and the cost of a crashed dashboard is real.
 *   4. a11y. It is a status message, not an alert that steals focus, and the
 *      dismiss control is a real button with an accessible name.
 *
 * No next/dynamic in this tree, so there is nothing to stub for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { AnnouncementBanner } from "@/app/(app)/dashboard/announcement-banner";
import { ANNOUNCEMENT, ANNOUNCEMENT_STORAGE_KEY } from "@/lib/announce/announcement";

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("the banner carries the owner's words", () => {
  it("renders the headline and one true supporting line", async () => {
    render(<AnnouncementBanner />);
    expect(await screen.findByText("Your FounderFlow just got cooler!")).toBeInTheDocument();
    expect(screen.getByText(ANNOUNCEMENT.body)).toBeInTheDocument();
  });

  it("is a status message, not an alert, and the dismiss control is a named button", async () => {
    render(<AnnouncementBanner />);
    const region = await screen.findByRole("status");
    expect(region).toHaveTextContent("Your FounderFlow just got cooler!");
    expect(screen.queryByRole("alert")).toBeNull();
    const button = screen.getByRole("button", { name: /dismiss announcement/i });
    expect(button).toHaveAttribute("type", "button");
  });
});

describe("it contributes nothing to the first paint", () => {
  it("server-renders to empty markup, so a dismissed reader sees no flash", () => {
    // The server has no localStorage and therefore no way to know. Anything it
    // emitted here would appear for one frame on every dashboard load — for the
    // people who already dismissed it most of all, because they are the ones
    // who have loaded the page before.
    expect(renderToStaticMarkup(<AnnouncementBanner />)).toBe("");
  });
});

describe("dismissal is one-time, per browser", () => {
  it("hides the banner and records the flag under this announcement's own key", async () => {
    render(<AnnouncementBanner />);
    await userEvent.click(await screen.findByRole("button", { name: /dismiss announcement/i }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(window.localStorage.getItem(ANNOUNCEMENT_STORAGE_KEY)).toBe("1");
    expect(ANNOUNCEMENT_STORAGE_KEY).toBe(`ff-announcement-${ANNOUNCEMENT.id}`);
  });

  it("stays gone on the next mount — a refresh or a navigation", async () => {
    const first = render(<AnnouncementBanner />);
    await userEvent.click(await screen.findByRole("button", { name: /dismiss announcement/i }));
    first.unmount();

    render(<AnnouncementBanner />);
    // Give the hydration effect a turn; it must still decide "no".
    await Promise.resolve();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("never shows for a browser that already holds the flag", async () => {
    window.localStorage.setItem(ANNOUNCEMENT_STORAGE_KEY, "1");
    render(<AnnouncementBanner />);
    await Promise.resolve();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores a flag belonging to a different announcement", async () => {
    window.localStorage.setItem("ff-announcement-something-else", "1");
    render(<AnnouncementBanner />);
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });
});

describe("localStorage may be unavailable", () => {
  it("still renders when the read throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("The operation is insecure.");
    });
    render(<AnnouncementBanner />);
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("still dismisses for this page when the write throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    render(<AnnouncementBanner />);
    await userEvent.click(await screen.findByRole("button", { name: /dismiss announcement/i }));
    // The flag could not be stored, so it will be back next load — but the
    // click the user made must still do something, and nothing may throw.
    expect(screen.queryByRole("status")).toBeNull();
  });
});
