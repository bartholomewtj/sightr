// T29 (optional piece): a sent message that holds review blocks draws each block as a collapsed card in the timeline;
// the text around it stays markdown, and text that is not a well-formed block stays as it was.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { TurnItem } from "@shared/v2/contracts";

import { formatReviewBlock } from "@/lib/reviewCommentContext";
import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { thread as threadFixture } from "@/test/fixtures";
import { installListLayout } from "@/test/list-layout";
import { resetOrdinals, user } from "@/test/turn-items";

import { MessagesTimeline } from "./MessagesTimeline";

beforeEach(() => {
  resetOrdinals();
  installListLayout();
});

async function show(items: TurnItem[]) {
  useThreadStore.setState({
    current: threadFromSnapshot(
      { sequence: 1, thread: threadFixture("t1", { capabilities: { ...threadFixture("t1").capabilities, hasJournal: true } }), runs: [], items, requests: [], queue: [], historyCursor: null },
      false,
    ),
    missing: null,
  });
  render(<MessagesTimeline threadId="t1" />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

const block = formatReviewBlock({
  path: "src/lib/foo.ts",
  start: 12,
  end: 14,
  side: "new",
  quote: ["+const a = 1;", " const b = 2;", "+const c = 3;"],
  note: "Rename `a` to say what it counts.",
});
const cards = () => Array.from(document.querySelectorAll<HTMLElement>("[data-review-card]"));

describe("review comment cards", () => {
  it("draws a block as a collapsed card with the path, range and side, and the user's own text around it", async () => {
    await show([user("u:0", `please look at this\n\n${block}\n\nthanks`)]);
    expect(cards()).toHaveLength(1);
    const header = within(cards()[0]!).getByRole("button", { expanded: false });
    expect(header).toHaveTextContent("src/lib/foo.ts:12-14");
    expect(header).toHaveTextContent("new");
    expect(screen.getByText("please look at this")).toBeInTheDocument();
    expect(screen.getByText("thanks")).toBeInTheDocument();
    // Collapsed: no quote and no note yet.
    expect(screen.queryByLabelText("Quoted lines")).toBeNull();
    expect(screen.queryByText(/Rename/)).toBeNull();
  });

  it("opens to the tinted quote and the note, and closes again", async () => {
    await show([user("u:0", block)]);
    const header = within(cards()[0]!).getByRole("button");
    fireEvent.click(header);
    const quote = screen.getByLabelText("Quoted lines");
    expect(quote).toHaveTextContent("+const a = 1;");
    expect(quote.children).toHaveLength(3);
    expect(quote.children[0]!.className).toContain("--ok");
    expect(quote.children[1]!.className).not.toContain("--ok");
    expect(screen.getByText(/Rename/)).toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.queryByLabelText("Quoted lines")).toBeNull();
  });

  it("draws several blocks as several cards", async () => {
    const other = formatReviewBlock({ path: "b.ts", start: 3, end: 3, side: "old", outdated: true, quote: ["-gone"], note: "why?" });
    await show([user("u:0", `${block}\n\n${other}`)]);
    expect(cards()).toHaveLength(2);
    expect(cards()[1]).toHaveTextContent("b.ts:3");
    expect(cards()[1]).toHaveTextContent("outdated");
  });

  it("falls back to the plain message for text that only looks like a block", async () => {
    await show([user("u:0", "[review] a.ts:1 (new)\nthis has no fence\n> and a note")]);
    expect(cards()).toHaveLength(0);
    expect(screen.getByText(/this has no fence/)).toBeInTheDocument();
  });

  it("leaves an ordinary message alone", async () => {
    await show([user("u:0", "just a **message**")]);
    expect(cards()).toHaveLength(0);
    expect(screen.getByText("message").tagName).toBe("STRONG");
  });
});
