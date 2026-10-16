import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { isDirectArmed } from "@v1/lib/direct-arm";
import { useRightPanelStore } from "@/rightPanelStore";
import { threadFromSnapshot } from "@/stream/apply";
import { useBridgeInfo, useThreadStore } from "@/stream/stores";
import { thread, threadSnapshot } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";

import { TerminalPanel } from "./TerminalPanel";

let keyPosts: { paneId: string; keys: string[]; typed?: boolean }[] = [];

beforeEach(() => {
  keyPosts = [];
  server.use(
    http.get("/api/pane/:id", ({ params }) => HttpResponse.json({ paneId: params.id, text: "$ ready\n", truncated: false, revision: 1 })),
    http.post("/api/pane/:id/keys", async ({ request, params }) => {
      const body = (await request.json()) as { keys: string[]; typed?: boolean };
      keyPosts.push({ paneId: String(params.id), ...body });
      return HttpResponse.json({ ok: true });
    }),
  );
  act(() => useThreadStore.setState({ current: threadFromSnapshot(threadSnapshot(3, thread("t1", { harness: "shell" })), false), missing: null }));
});

const typeBox = () => screen.getByLabelText("Type into the terminal") as HTMLTextAreaElement;

describe("TerminalPanel", () => {
  it("mirrors the pane", async () => {
    render(<TerminalPanel threadId="t1" />);
    expect(await screen.findByText(/\$ ready/)).toBeInTheDocument();
  });

  it("says the pane was closed, and reads nothing, for a thread archived with its pane", async () => {
    let reads = 0;
    server.use(http.get("/api/pane/:id", () => { reads++; return HttpResponse.json({ text: "x" }); }));
    const gone = thread("t1", { harness: "shell", shelf: "archived", archiveReason: "pane-closed" });
    act(() => useThreadStore.setState({ current: threadFromSnapshot(threadSnapshot(3, gone), false), missing: null }));
    render(<TerminalPanel threadId="t1" />);
    expect(screen.getByText(/pane was closed/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(reads).toBe(0);
  });

  it("arming shows the strip; keys post to the pane's key route (typed); blur disarms on desktop", async () => {
    setViewportWidth(1200);
    render(<TerminalPanel threadId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Type into terminal" }));
    expect(await screen.findByText("Typing into terminal")).toBeInTheDocument();
    expect(isDirectArmed()).toBe(true);
    fireEvent.change(typeBox(), { target: { value: "ls" } });
    fireEvent.keyDown(typeBox(), { key: "Enter" });
    await waitFor(() => expect(keyPosts.flatMap((p) => p.keys)).toEqual(["l", "s", "Enter"]));
    expect(keyPosts.every((p) => p.paneId === "p-t1" && p.typed === true)).toBe(true);
    fireEvent.blur(typeBox());
    await waitFor(() => expect(screen.queryByText("Typing into terminal")).toBeNull());
    expect(isDirectArmed()).toBe(false);
  });

  it("holds a multi-line paste until Send", async () => {
    setViewportWidth(1200);
    render(<TerminalPanel threadId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Type into terminal" }));
    await screen.findByText("Typing into terminal");
    const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = { items: [], getData: () => "echo one\necho two\n" };
    act(() => {
      typeBox().dispatchEvent(paste);
    });
    expect(await screen.findByText("Paste 2 lines into the terminal?")).toBeInTheDocument();
    expect(keyPosts).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(keyPosts.flatMap((p) => p.keys)).toContain("Enter"));
  });

  it("a read-only device sees the mirror and no controls", async () => {
    act(() => useBridgeInfo.setState({ readOnly: true }));
    render(<TerminalPanel threadId="t1" />);
    expect(await screen.findByText(/\$ ready/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Type into terminal" })).toBeNull();
    expect(screen.queryByLabelText("Type into the terminal")).toBeNull();
    expect(screen.queryByRole("button", { name: "Keys" })).toBeNull();
  });

  it("a password request opens armed, with the strip naming the prompt", async () => {
    act(() => useRightPanelStore.getState().requestDirectTyping("t1", "[sudo] password for bart:"));
    render(<TerminalPanel threadId="t1" />);
    expect(await screen.findByText(/answering: \[sudo\] password for bart:/)).toBeInTheDocument();
    expect(useRightPanelStore.getState().directTyping).toBeNull();
  });

  it("docks the Keys pad under the mirror on a phone", async () => {
    setViewportWidth(390);
    render(<TerminalPanel threadId="t1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Keys" }));
    expect(document.querySelector("[data-keys-dock]")).not.toBeNull();
  });

  it("keeps the font size per device, 10 to 16 px", async () => {
    render(<TerminalPanel threadId="t1" />);
    const larger = await screen.findByRole("button", { name: "Larger text" });
    for (let i = 0; i < 10; i++) fireEvent.click(larger);
    expect(useRightPanelStore.getState().terminalFontSize).toBe(16);
    expect(larger).toBeDisabled();
    expect(JSON.parse(localStorage.getItem("sightr:v2:right-panel-state:v1") ?? "{}").state.terminalFontSize).toBe(16);
  });
});
