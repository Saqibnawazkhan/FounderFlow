/**
 * /chat — the two entry points the product owner could not find, and the tab
 * title that called a person a channel.
 *
 * chat-008, the browser-tab half. `generateMetadata` titled EVERY kind
 * `#${channel.name}`, so a direct message with Ahmed Khan put "#Ahmed Khan ·
 * FounderFlow" in the tab, the history and every bookmark. Reproduced in a
 * browser before this test was written:
 *
 *     --- OPEN CONVERSATION ---
 *     { "title": "#Ahmed Khan · FounderFlow",
 *       "placeholder": "Message #Ahmed Khan" }
 *
 * <EmptyChat>, the zero-channel half. The "Message a teammate" button was drawn
 * only when `dmCandidates.length > 0`, so the first person into a brand-new
 * workspace — who is very often alone in it — got no DM affordance at all and
 * <NewDmModal>'s own "you're the only person here, invite someone" copy could
 * never be reached.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChannelDetail } from "@/lib/queries/chat";

/* ── generateMetadata ─────────────────────────────────────────────────────── */

const queries = vi.hoisted(() => ({ getChannelBySlug: vi.fn() }));
vi.mock("@/lib/queries/chat", () => ({
  getChannelBySlug: queries.getChannelBySlug,
  getMessagesPage: vi.fn(),
  listChannelsForUser: vi.fn(),
  listDmCandidates: vi.fn(),
}));
vi.mock("@/lib/queries/session", () => ({ requireScopedSession: vi.fn() }));
vi.mock("@/app/(app)/chat/[slug]/chat-client", () => ({ ChatClient: () => null }));

function detail(overrides: Partial<ChannelDetail>): ChannelDetail {
  return {
    id: "c1",
    slug: "general",
    name: "general",
    kind: "public",
    topic: null,
    memberCount: 4,
    unreadCount: 0,
    lastMessageAt: null,
    isMember: true,
    archivedAt: null,
    members: [],
    myChannelRole: "member",
    ...overrides,
  } as ChannelDetail;
}

describe("generateMetadata for /chat/[slug] (chat-008)", () => {
  beforeEach(() => queries.getChannelBySlug.mockReset());

  it("hashes a room in the browser tab", async () => {
    const { generateMetadata } = await import("@/app/(app)/chat/[slug]/page");
    queries.getChannelBySlug.mockResolvedValue(detail({ kind: "public", name: "general" }));
    expect(await generateMetadata({ params: { slug: "general" } })).toMatchObject({
      title: "#general",
    });
  });

  it("does NOT hash a direct message", async () => {
    const { generateMetadata } = await import("@/app/(app)/chat/[slug]/page");
    queries.getChannelBySlug.mockResolvedValue(
      detail({ kind: "dm", slug: "dm-a_b", name: "Ahmed Khan" })
    );
    const meta = await generateMetadata({ params: { slug: "dm-a_b" } });
    expect(meta.title).toBe("Ahmed Khan");
  });

  it("still falls back to plain 'Chat' for a channel the reader may not see", async () => {
    // getChannelBySlug returns null both for absent and for forbidden, and the
    // title must not become a membership oracle either.
    const { generateMetadata } = await import("@/app/(app)/chat/[slug]/page");
    queries.getChannelBySlug.mockResolvedValue(null);
    expect(await generateMetadata({ params: { slug: "secret" } })).toMatchObject({ title: "Chat" });
  });
});

/* ── <EmptyChat> ──────────────────────────────────────────────────────────── */

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/chat/new-channel-modal", () => ({ NewChannelModal: () => null }));
const dmModal = vi.hoisted(() => ({ opened: { value: false } }));
vi.mock("@/components/chat/new-dm-modal", () => ({
  NewDmModal: ({ open }: { open: boolean }) => {
    dmModal.opened.value = dmModal.opened.value || open;
    return open ? <div role="dialog">New direct message</div> : null;
  },
}));

describe("<EmptyChat> — a brand-new workspace can still message a person", () => {
  beforeEach(() => {
    dmModal.opened.value = false;
  });

  it("offers the DM button when there are teammates", async () => {
    const { EmptyChat } = await import("@/app/(app)/chat/empty-chat");
    render(<EmptyChat dmCandidates={[{ id: "u2", name: "Ali Raza", existingSlug: null }]} />);
    expect(screen.getByRole("button", { name: /message a teammate/i })).toBeInTheDocument();
  });

  it("STILL offers it in a workspace of one", async () => {
    // The picker's own empty state is the honest answer ("invite someone from
    // the Team page"), and hiding the trigger was the only thing keeping that
    // copy unreachable — while leaving the reader with no DM affordance at all.
    const { EmptyChat } = await import("@/app/(app)/chat/empty-chat");
    render(<EmptyChat dmCandidates={[]} />);
    expect(screen.getByRole("button", { name: /message a teammate/i })).toBeInTheDocument();
  });

  it("opens the picker when it is pressed in a workspace of one", async () => {
    const { EmptyChat } = await import("@/app/(app)/chat/empty-chat");
    const user = userEvent.setup();
    render(<EmptyChat dmCandidates={[]} />);
    await user.click(screen.getByRole("button", { name: /message a teammate/i }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/new direct message/i);
  });
});
