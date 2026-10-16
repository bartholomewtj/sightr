// The per-device rows: Appearance, Display and Composer. Each round-trips through localStorage and
// survives a reload (the module stores re-read storage, as a page load would).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { NO_CAPABILITIES } from "@shared/v2/contracts";
import { ShortcutListener } from "@/components/GlobalShortcuts";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { __reloadDisplayPrefs, DISPLAY_PREFS_KEY } from "@/hooks/use-display-prefs";
import { __reloadTheme, THEME_STORAGE_KEY } from "@/hooks/use-theme";
import { useRightPanelStore } from "@/rightPanelStore";
import { __resetComposerState, __setComposerDeps, useComposerSettings } from "@/state/composer";
import { threadFromSnapshot } from "@/stream/apply";
import { useStreamHealth, useThreadStore } from "@/stream/stores";
import { thread as threadFixture } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";

import { ComposerSettings } from "./ComposerSettings";
import { DisplaySettings } from "./DisplaySettings";
import { ThemeSettings } from "./ThemeSettings";

const radio = (group: string, name: string) => within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });

describe("Appearance", () => {
  it("is dark by default and round-trips Light, System and Dark through a reload", () => {
    render(<ThemeSettings />);
    const root = document.documentElement;
    expect(radio("Appearance", "Dark")).toHaveAttribute("aria-checked", "true");
    expect(root.classList.contains("light")).toBe(false);

    fireEvent.click(radio("Appearance", "Light"));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(root.classList.contains("light")).toBe(true);
    act(() => __reloadTheme());
    expect(radio("Appearance", "Light")).toHaveAttribute("aria-checked", "true");

    fireEvent.click(radio("Appearance", "System"));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expect(root.classList.contains("system")).toBe(true);
    expect(root.classList.contains("light")).toBe(false);

    fireEvent.click(radio("Appearance", "Dark"));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(root.classList.contains("system")).toBe(false);
    act(() => __reloadTheme());
    expect(radio("Appearance", "Dark")).toHaveAttribute("aria-checked", "true");
  });
});

describe("Display", () => {
  it("Show thinking writes v1's display-prefs key, keeps v1's other fields, and survives a reload", () => {
    localStorage.setItem(DISPLAY_PREFS_KEY, JSON.stringify({ fontSize: 14, rawTerminal: false, showThinking: true }));
    act(() => __reloadDisplayPrefs());
    render(<DisplaySettings />);
    const sw = screen.getByRole("switch", { name: "Show thinking" });
    expect(sw).toBeChecked();
    fireEvent.click(sw);
    expect(JSON.parse(localStorage.getItem(DISPLAY_PREFS_KEY)!)).toEqual({ fontSize: 14, rawTerminal: false, showThinking: false });
    act(() => __reloadDisplayPrefs());
    expect(screen.getByRole("switch", { name: "Show thinking" })).not.toBeChecked();
  });

  it("Terminal text size steps the Terminal tab's font, within its bounds", () => {
    render(<DisplaySettings />);
    const start = useRightPanelStore.getState().terminalFontSize;
    fireEvent.click(screen.getByRole("button", { name: "Increase terminal text size" }));
    expect(useRightPanelStore.getState().terminalFontSize).toBe(start + 1);
    expect(screen.getByTestId("terminal-font-size")).toHaveTextContent(`${start + 1}px`);
    for (let i = 0; i < 20; i++) fireEvent.click(screen.getByRole("button", { name: "Decrease terminal text size" }));
    expect(screen.getByRole("button", { name: "Decrease terminal text size" })).toBeDisabled();
  });

  it("has no desktop-mode control (the layout is width-based)", () => {
    render(<DisplaySettings />);
    expect(screen.queryByText(/desktop/i)).toBeNull();
  });
});

describe("Composer", () => {
  let posts: Record<string, unknown>[] = [];
  const ALL = { ...NO_CAPABILITIES, hasJournal: true, canInterrupt: true, canQueueDrain: true, interruptKeys: ["Escape"] };

  beforeEach(() => {
    posts = [];
    setViewportWidth(800);
    let n = 0;
    __setComposerDeps({ command: () => ({ fetch: (...a) => globalThis.fetch(...a), newId: () => `cmd-${++n}` }) });
    server.use(
      http.post("/api/v2/command", async ({ request }) => {
        posts.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true, sequence: 100 + posts.length });
      }),
    );
    useStreamHealth.setState({ status: "live" });
  });

  function showWithComposer(status: "idle" | "working" = "idle") {
    useThreadStore.setState({
      current: threadFromSnapshot(
        {
          sequence: 1,
          thread: threadFixture("t1", { capabilities: ALL, status }),
          runs: [],
          items: [],
          requests: [],
          queue: [],
          historyCursor: null,
        },
        false,
      ),
      missing: null,
    });
    return render(
      <>
        <ComposerSettings />
        <ShortcutListener />
        <ChatComposer threadId="t1" />
      </>,
    );
  }

  const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;

  it("reflects the stored values, with the phone default when nothing is stored", () => {
    localStorage.setItem("sightr:v2:composer:follow-up", "steer");
    __resetComposerState();
    render(<ComposerSettings />);
    expect(radio("Enter key", "Mod+Enter sends")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/The phone default/)).toBeInTheDocument();
    expect(radio("While the agent works", "Steer")).toHaveAttribute("aria-checked", "true");
  });

  it("changing Enter here changes what Enter does in the composer, and is stored", async () => {
    showWithComposer();
    fireEvent.change(box(), { target: { value: "hi" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(posts).toHaveLength(0);

    fireEvent.click(radio("Enter key", "Enter sends"));
    expect(localStorage.getItem("sightr:v2:composer:enter")).toBe("enter");
    expect(useComposerSettings.getState().enterMode).toBe("enter");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(posts).toEqual([expect.objectContaining({ type: "message.dispatch", text: "hi", mode: "start" })]));
  });

  it("changing the follow-up here changes what a send does while the agent works", async () => {
    showWithComposer("working");
    fireEvent.change(box(), { target: { value: "next" } });
    const primary = () => document.querySelector<HTMLButtonElement>("[data-primary-kind]")!;
    expect(primary()).toHaveAccessibleName("Queue");
    fireEvent.click(radio("While the agent works", "Steer"));
    expect(localStorage.getItem("sightr:v2:composer:follow-up")).toBe("steer");
    expect(primary()).toHaveAccessibleName("Steer");
    fireEvent.click(primary());
    await waitFor(() => expect(posts).toEqual([expect.objectContaining({ type: "message.dispatch", mode: "steer" })]));
  });

  it("the composer no longer carries its own settings menu", () => {
    showWithComposer();
    expect(screen.queryByRole("button", { name: "Composer settings" })).toBeNull();
  });
});
