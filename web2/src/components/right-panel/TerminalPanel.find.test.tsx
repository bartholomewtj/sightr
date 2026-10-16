import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { threadFromSnapshot } from "@/stream/apply";
import { useThreadStore } from "@/stream/stores";
import { thread, threadSnapshot } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";

import { TerminalPanel } from "./TerminalPanel";

// T19: find over the Terminal mirror, and the harness statusline in the tab's header. That web2 names no
// harness id is the root suite's lint test (scripts/web2-harness-ids.test.ts), which scans web2/src.

const RULE = "─".repeat(40);
// A Claude screen: output, the input box, and two statusline rows under it.
const CLAUDE_SCREEN = ["build ok", "build ok again", RULE, "❯ ", RULE, "Opus 4 · ctx 12%", "main · 3 files changed"].join("\n");

let paneText = CLAUDE_SCREEN;

beforeEach(() => {
  paneText = CLAUDE_SCREEN;
  setViewportWidth(1200);
  server.use(
    http.get("/api/pane/:id", ({ params }) => HttpResponse.json({ paneId: params.id, text: paneText, truncated: false, revision: 1 })),
  );
});

function show(harness: string) {
  act(() => useThreadStore.setState({ current: threadFromSnapshot(threadSnapshot(3, thread("t1", { harness })), false), missing: null }));
  return render(<TerminalPanel threadId="t1" />);
}

const matches = () => [...document.querySelectorAll("[data-find-match]")];
const current = () => document.querySelector('[data-find-match="current"]');

describe("Terminal tab: find", () => {
  it("highlights every hit in the mirror and steps over them, wrapping; close clears it", async () => {
    show("shell");
    await screen.findByText(/build ok again/);
    fireEvent.click(screen.getByRole("button", { name: "Find in output" }));
    const input = screen.getByRole("textbox", { name: "Find in output" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "build" } });
    await waitFor(() => expect(matches()).toHaveLength(2));
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(current()?.textContent).toBe("build");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("2/2")).toBeInTheDocument());
    expect(matches().indexOf(current()!)).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    await waitFor(() => expect(screen.getByText("1/2")).toBeInTheDocument());
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(screen.getByText("2/2")).toBeInTheDocument());
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Find in output" })).toBeNull());
    expect(matches()).toHaveLength(0);
  });

  it("mod+f on the focused mirror opens the bar", async () => {
    show("shell");
    await screen.findByText(/build ok again/);
    const mirror = screen.getByLabelText("Terminal");
    mirror.focus();
    fireEvent.keyDown(mirror, { key: "f", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: "Find in output" })).toBeInTheDocument();
  });
});

describe("Terminal tab: statusline", () => {
  it("a Claude pane shows its statusline rows in the header, from the mirror's own read", async () => {
    show("claude");
    const strip = await waitFor(() => {
      const el = document.querySelector("[data-terminal-statusline]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(strip.textContent).toContain("Opus 4 · ctx 12%");
    expect(strip.textContent).toContain("main · 3 files changed");
    expect(strip.textContent).not.toContain("build ok");
  });

  it("a harness with no adapter (a shell) shows none", async () => {
    show("shell");
    await screen.findByText(/build ok again/);
    expect(document.querySelector("[data-terminal-statusline]")).toBeNull();
  });
});
