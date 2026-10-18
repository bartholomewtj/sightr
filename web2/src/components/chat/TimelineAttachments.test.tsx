import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatAttachment, Thread, TurnItem } from "@shared/v2/contracts";

import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { thread as threadFixture } from "@/test/fixtures";
import { installListLayout } from "@/test/list-layout";
import { read, resetOrdinals, run, user } from "@/test/turn-items";

import { MessagesTimeline } from "./MessagesTimeline";
import { isImageAttachment, TimelineAttachments, timelineImages } from "./TimelineAttachments";

const LOGO: ChatAttachment = { type: "image", id: "j_abc_120_0_xyz", name: "logo.png", path: "", mimeType: "image/png", sizeBytes: 70 };
const UPLOAD: ChatAttachment = { name: "photo.jpg", path: "C:/state/uploads/w1_p1-mgx0a1-0123abcd.jpg" };
const NOTE: ChatAttachment = { type: "file", id: "u_w1_p1-mgx0a1-0123abcd.md", name: "notes.md", path: "C:/state/uploads/w1_p1-mgx0a1-0123abcd.md" };

describe("helpers", () => {
  it("an image is typed as one, has an image mime, or an image path (a dispatch chip)", () => {
    expect(isImageAttachment(LOGO)).toBe(true);
    expect(isImageAttachment(UPLOAD)).toBe(true);
    expect(isImageAttachment(NOTE)).toBe(false);
    expect(isImageAttachment({ name: "a.txt", path: "/x/a.txt" })).toBe(false);
  });

  it("urls name the item and the attachment's index, files keep their index", () => {
    expect(timelineImages("t 1", "e1:0", [NOTE, LOGO])).toEqual([
      { src: "/api/v2/thread/t%201/item/e1%3A0/attachment/1", name: "logo.png", key: LOGO.id },
    ]);
  });
});

describe("TimelineAttachments", () => {
  it("draws a reserved-ratio tile per image, lazy, with alt text and a 44px+ button; files as chips", () => {
    render(<TimelineAttachments threadId="t1" itemId="e1:0" attachments={[LOGO, NOTE]} variant="message" />);
    const img = screen.getByRole("img", { name: "logo.png" });
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("src", "/api/v2/thread/t1/item/e1%3A0/attachment/0");
    expect(img.closest("div")).toHaveClass("aspect-[4/3]");
    expect(screen.getByRole("button", { name: "Preview logo.png" })).toHaveClass("size-full");
    expect(screen.getByText("notes.md")).toBeInTheDocument();
  });

  it("a tap opens the image viewer at that image", () => {
    render(<TimelineAttachments threadId="t1" itemId="e1:0" attachments={[LOGO, UPLOAD]} variant="tool" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview photo.jpg" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("photo.jpg (2/2)")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close image preview" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an image the bridge cannot find becomes a labelled placeholder, not a broken image", () => {
    render(<TimelineAttachments threadId="t1" itemId="e1:0" attachments={[LOGO]} variant="message" />);
    fireEvent.error(screen.getByRole("img", { name: "logo.png" }));
    expect(screen.getByRole("img", { name: "logo.png (unavailable)" })).toHaveTextContent("Image unavailable");
    expect(screen.queryByRole("button", { name: "Preview logo.png" })).toBeNull();
  });

  it("nothing to show, nothing drawn", () => {
    const { container } = render(<TimelineAttachments threadId="t1" itemId="e1:0" attachments={[]} variant="tool" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("in the timeline", () => {
  beforeEach(() => {
    resetOrdinals();
    installListLayout();
  });
  afterEach(() => vi.restoreAllMocks());

  function setThread(items: TurnItem[], over: Partial<Thread> = {}) {
    useThreadStore.setState({
      current: threadFromSnapshot(
        {
          sequence: 1,
          thread: threadFixture("t1", { capabilities: { ...threadFixture("t1").capabilities, hasJournal: true }, ...over }),
          runs: [run("r1", { status: "running", completedAt: undefined, startedAt: Date.now() })],
          items,
          requests: [],
          queue: [],
          historyCursor: null,
        },
        false,
      ),
      missing: null,
    });
  }
  const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 50))));

  it("a user's pasted image sits in their bubble, above the words", async () => {
    const message = { ...user("u:0", "what is this?", { runId: "r1" }), attachments: [LOGO] } as TurnItem;
    setThread([message]);
    render(<MessagesTimeline threadId="t1" />);
    await settle();
    const img = screen.getByRole("img", { name: "logo.png" });
    expect(img).toHaveAttribute("src", "/api/v2/thread/t1/item/u%3A0/attachment/0");
    expect(img.compareDocumentPosition(screen.getByText("what is this?")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a Read of an image carries an image mark and opens to its thumbnail", async () => {
    const shot = { ...read("a:0", "assets/logo.png", { runId: "r1", output: "" }), attachments: [LOGO] } as TurnItem;
    setThread([user("u:0", "look", { runId: "r1" }), shot, read("b:0", "README.md", { runId: "r1", output: "x" })]);
    render(<MessagesTimeline threadId="t1" />);
    await settle();
    const row = document.querySelector('[data-tool-images="1"]')!.closest('[role="button"]') as HTMLElement;
    expect(within(row).getByText("1 image")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "logo.png" })).toBeNull();
    fireEvent.click(row);
    await settle();
    expect(screen.getByRole("img", { name: "logo.png" })).toHaveAttribute("src", "/api/v2/thread/t1/item/a%3A0/attachment/0");
  });
});
