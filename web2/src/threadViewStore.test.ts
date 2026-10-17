import { describe, expect, it } from "vitest";

import { NO_CAPABILITIES } from "@shared/v2/contracts";

import { useRightPanelStore } from "@/rightPanelStore";
import { useShell } from "@/stream/stores";
import { thread } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";

import { openThreadTerminal, resolveThreadView, threadViewOf, toggleThreadTerminal, useThreadViewStore } from "./threadViewStore";

/** Puts threads in the shell store: `shell` has no transcript, `agent` has one. */
function seed(): void {
  useShell.setState({
    threads: {
      shell: thread("shell", { harness: "shell", capabilities: { ...NO_CAPABILITIES } }),
      agent: thread("agent", { capabilities: { ...NO_CAPABILITIES, hasJournal: true } }),
    },
  });
}

describe("threadViewStore", () => {
  it("defaults to the CLI only for a thread known to have no transcript", () => {
    expect(resolveThreadView(false, undefined)).toBe("cli");
    expect(resolveThreadView(false, "thread")).toBe("thread");
    expect(resolveThreadView(true, undefined)).toBe("thread");
    // A pick never moves a thread with a transcript off its timeline.
    expect(resolveThreadView(true, "cli")).toBe("thread");
    // Not loaded yet: the timeline (its skeleton) until capabilities arrive.
    expect(resolveThreadView(undefined, undefined)).toBe("thread");
  });

  it("opens the terminal of a no-transcript thread as its main view, closing a phone sheet", () => {
    seed();
    setViewportWidth(390);
    useThreadViewStore.getState().setView("shell", "thread");
    useRightPanelStore.getState().openSheet("files");
    openThreadTerminal("shell");
    expect(threadViewOf("shell")).toBe("cli");
    expect(useRightPanelStore.getState().sheet).toBeNull();
  });

  it("opens the panel tab (or sheet) for a thread with a transcript, or with no thread", () => {
    seed();
    setViewportWidth(1280);
    useRightPanelStore.getState().open("git");
    openThreadTerminal("agent");
    expect(useRightPanelStore.getState()).toMatchObject({ isOpen: true, activeSurfaceId: "terminal" });
    expect(threadViewOf("agent")).toBe("thread");
    setViewportWidth(390);
    openThreadTerminal(null);
    expect(useRightPanelStore.getState().sheet).toBe("terminal");
  });

  it("terminal.toggle flips a no-transcript thread's main view and leaves the panel alone", () => {
    seed();
    setViewportWidth(1280);
    useRightPanelStore.getState().open("files");
    toggleThreadTerminal("shell");
    expect(threadViewOf("shell")).toBe("thread");
    toggleThreadTerminal("shell");
    expect(threadViewOf("shell")).toBe("cli");
    expect(useRightPanelStore.getState()).toMatchObject({ isOpen: true, activeSurfaceId: "files" });
    toggleThreadTerminal("agent");
    expect(useRightPanelStore.getState().activeSurfaceId).toBe("terminal");
  });
});
