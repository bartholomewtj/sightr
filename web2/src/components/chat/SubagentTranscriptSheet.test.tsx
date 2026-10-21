// T33: the subagent transcript hook and sheet, against a fake bridge (`fetch` answers per request).
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TurnItem } from "@shared/v2/contracts";

import { useSubagentActivity, useSubagentTranscript } from "~/lib/subagentTranscript";
import { assistant, command, reasoning, resetOrdinals, user } from "@/test/turn-items";

import { SubagentTranscriptSheet, toolLabel } from "./SubagentTranscriptSheet";

beforeEach(() => resetOrdinals());
afterEach(() => vi.restoreAllMocks());

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

function fakeBridge(handler: (url: URL) => Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => handler(new URL(String(input), "http://x")));
}

const items = (): TurnItem[] => [
  user("u:0", "Fix PR 1153."),
  reasoning("r:0", "**Checking the diff** first"),
  command("c:0", "git status", { output: "clean" }),
  assistant("a:0", "Nothing to do."),
];

describe("useSubagentTranscript", () => {
  it("loads once, then polls with the size it has and keeps the view while the file is unchanged", async () => {
    const sizes: (string | null)[] = [];
    fakeBridge((url) => {
      sizes.push(url.searchParams.get("size"));
      return sizes.length === 1 ? json({ ok: true, size: 500, running: true, cutHead: false, items: items() }) : json({ ok: true, unchanged: true, size: 500 });
    });
    const { result, unmount } = renderHook(() => useSubagentTranscript("t1", "s1", { enabled: true, live: true, pollMs: 15 }));
    await waitFor(() => expect(result.current.view?.items).toHaveLength(4));
    await waitFor(() => expect(sizes.length).toBeGreaterThanOrEqual(3));
    expect(sizes.slice(0, 3)).toEqual([null, "500", "500"]);
    expect(result.current.view?.items).toHaveLength(4);
    unmount();
    const after = sizes.length;
    await act(async () => void (await new Promise((r) => setTimeout(r, 60))));
    expect(sizes.length).toBeLessThanOrEqual(after + 1); // stopped with the view
  });

  it("does not poll for a finished agent", async () => {
    const spy = fakeBridge(() => json({ ok: true, size: 9, running: false, cutHead: false, items: items() }));
    const { result } = renderHook(() => useSubagentTranscript("t1", "s1", { enabled: true, live: false, pollMs: 10 }));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    await act(async () => void (await new Promise((r) => setTimeout(r, 60))));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reports an agent with no log as unavailable, without a view", async () => {
    fakeBridge(() => json({ ok: false, code: "not_found", error: "no-transcript" }, 404));
    const { result } = renderHook(() => useSubagentTranscript("t1", "s1", { enabled: true, live: false }));
    await waitFor(() => expect(result.current.error).toEqual({ reason: "no-transcript", unavailable: true }));
    expect(result.current.view).toBeNull();
  });
});

describe("useSubagentActivity", () => {
  it("shows the newest action of a running agent, and asks for nothing when disabled", async () => {
    const spy = fakeBridge((url) => (url.searchParams.get("latest") === "1" ? json({ ok: true, latest: { label: "Running", text: "git status" }, size: 1, running: true, toolCount: 1 }) : json({})));
    const off = renderHook(() => useSubagentActivity("t1", "s1", false));
    expect(spy).not.toHaveBeenCalled();
    off.unmount();
    const { result } = renderHook(() => useSubagentActivity("t1", "s1", true));
    await waitFor(() => expect(result.current).toEqual({ label: "Running", text: "git status" }));
  });
});

describe("toolLabel", () => {
  it("says what a call did in a few words", () => {
    expect(toolLabel(command("c:1", "npm test\nmore"))).toEqual({ verb: "Ran", text: "npm test" });
    expect(toolLabel(user("u:1", "x"))).toBeNull();
  });
});

describe("SubagentTranscriptSheet", () => {
  const props = { threadId: "t1", itemId: "s1", title: "Fix PR #1153", statusLabel: "Running in the background", running: false, open: true, onClose: () => {} };

  it("shows the brief, the agent's words and a tool call that opens to its output", async () => {
    fakeBridge(() => json({ ok: true, size: 10, running: false, cutHead: false, items: items() }));
    render(<SubagentTranscriptSheet {...props} />);
    const body = await screen.findByText("Nothing to do.");
    expect(body).toBeInTheDocument();
    const sheet = document.querySelector("[data-subagent-transcript]") as HTMLElement;
    expect(within(sheet).getByText(/Brief · Fix PR 1153\./)).toBeInTheDocument();
    expect(within(sheet).getByText(/Thinking · \*\*Checking the diff\*\* first/)).toBeInTheDocument();
    expect(within(sheet).queryByText("clean")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: /Ran\s*git status/ }));
    expect(await within(sheet).findByText("clean")).toBeInTheDocument();
    expect(within(sheet).getByText("Fix PR #1153")).toBeInTheDocument();
  });

  it("says why when the agent's log cannot be opened", async () => {
    fakeBridge(() => json({ ok: false, code: "not_found", error: "no-transcript" }, 404));
    render(<SubagentTranscriptSheet {...props} />);
    expect(await screen.findByText(/log isn't available yet/)).toBeInTheDocument();
  });

  it("marks a live view and says when the log's start was cut", async () => {
    fakeBridge(() => json({ ok: true, size: 10, running: true, cutHead: true, items: items() }));
    render(<SubagentTranscriptSheet {...props} running />);
    await screen.findByText("Nothing to do.");
    expect(document.querySelector("[data-transcript-status]")).toHaveTextContent("Running in the background · live");
    expect(screen.getByText(/Earlier steps are cut/)).toBeInTheDocument();
  });

  it("closes from its own button", async () => {
    fakeBridge(() => json({ ok: true, size: 10, running: false, cutHead: false, items: items() }));
    const onClose = vi.fn();
    render(<SubagentTranscriptSheet {...props} onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close the transcript" }));
    expect(onClose).toHaveBeenCalled();
  });
});
