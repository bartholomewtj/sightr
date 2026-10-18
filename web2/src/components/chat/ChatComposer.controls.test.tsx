// The composer's controls from T3's chat folder: the live permission-mode menu
// (CompactComposerControlsMenu), Stop/Steer from capability flags, staged-image thumbnails and the
// viewer, the prompt length line and the snoozed/settled status line.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { capabilitiesFor } from "@shared/agents";
import type { Thread } from "@shared/v2/contracts";
import { __setComposerDeps, setFollowUp } from "@/state/composer";
import { threadFromSnapshot } from "@/stream/apply";
import { useBridgeInfo, useStreamHealth, useThreadStore } from "@/stream/stores";
import { thread as threadFixture } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";

import { ChatComposer } from "./ChatComposer";
import { MAX_COMPOSER_CHARS } from "./ChatComposer.logic";

const CLAUDE = capabilitiesFor("claude");
const PI = capabilitiesFor("pi");

let posts: Record<string, unknown>[] = [];
let reply: (body: Record<string, unknown>) => Response | undefined = () => undefined;

beforeEach(() => {
  posts = [];
  reply = () => undefined;
  setViewportWidth(800);
  let n = 0;
  __setComposerDeps({ command: () => ({ fetch: (...a) => globalThis.fetch(...a), newId: () => `cmd-${++n}` }) });
  server.use(
    http.post("/api/v2/command", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      posts.push(body);
      return reply(body) ?? HttpResponse.json({ ok: true, sequence: 200 + posts.length });
    }),
  );
  useStreamHealth.setState({ status: "live" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function show(over: Partial<Thread> = {}) {
  useThreadStore.setState({
    current: threadFromSnapshot(
      {
        sequence: 1,
        thread: threadFixture("t1", { capabilities: CLAUDE, permissionMode: "acceptEdits", ...over }),
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
  return render(<ChatComposer threadId="t1" />);
}

const commands = (type: string) => posts.filter((p) => p.type === type);
const modeTrigger = () => document.querySelector<HTMLButtonElement>('[data-composer-control="permission-mode"]');

async function openModeMenu() {
  const trigger = modeTrigger()!;
  fireEvent.click(trigger);
  return screen.findByRole("menu");
}

describe("ChatComposer: permission mode (CompactComposerControlsMenu)", () => {
  it("shows the thread's mode on the trigger and switches a resting thread live", async () => {
    show();
    expect(modeTrigger()).toHaveAccessibleName("Permission mode: Accept edits");
    const menu = await openModeMenu();
    const items = within(menu).getAllByRole("menuitemradio");
    // The capability list's order, the launch table's labels.
    expect(items.map((i) => i.textContent)).toEqual(["Ask first", "Accept edits", "Plan", "Auto", "Bypass permissionsasks first"]);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Plan" }));
    await waitFor(() => expect(commands("thread.permissionMode.set")).toHaveLength(1));
    expect(commands("thread.permissionMode.set")[0]).toEqual({ commandId: "cmd-1", type: "thread.permissionMode.set", threadId: "t1", mode: "plan" });
  });

  it("on a phone the chip shows the one-word name in full; the aria-label and menu keep the full name", async () => {
    setViewportWidth(360);
    show();
    const trigger = modeTrigger()!;
    expect(trigger).toHaveAccessibleName("Permission mode: Accept edits");
    expect(trigger.textContent).toBe("Edits");
    expect(trigger.className).toMatch(/shrink-0/);
    const menu = await openModeMenu();
    expect(within(menu).getAllByRole("menuitemradio").map((i) => i.textContent)).toContain("Accept edits");
  });

  it("bypass needs a second tap on the confirm strip, which sends confirmBypass", async () => {
    show();
    const menu = await openModeMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Bypass permissions/ }));
    const confirm = await screen.findByRole("alertdialog", { name: "Confirm the permission mode" });
    expect(posts).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole("button", { name: "Switch to Bypass permissions" }));
    await waitFor(() => expect(commands("thread.permissionMode.set")).toHaveLength(1));
    expect(commands("thread.permissionMode.set")[0]).toMatchObject({ mode: "bypassPermissions", confirmBypass: true });
    expect(screen.queryByRole("alertdialog", { name: "Confirm the permission mode" })).toBeNull();
  });

  it("Cancel on the confirm strip sends nothing", async () => {
    show();
    const menu = await openModeMenu();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Bypass permissions/ }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it("while the agent works the menu says why and its modes are disabled", async () => {
    show({ status: "working" });
    const menu = await openModeMenu();
    expect(within(menu).getByText("The agent is working. Change the mode when it stops.")).toBeInTheDocument();
    for (const item of within(menu).getAllByRole("menuitemradio")) expect(item).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Plan" }));
    expect(posts).toHaveLength(0);
  });

  it("a bridge refusal after keys went out lands in the error banner with the mode the footer showed", async () => {
    reply = () => HttpResponse.json({ ok: false, code: "conflict", error: "bypass-reached", shown: "bypassPermissions" }, { status: 409 });
    show();
    fireEvent.click(within(await openModeMenu()).getByRole("menuitemradio", { name: "Auto" }));
    expect(await screen.findByText(/stopped at Bypass permissions on the way.*It is now in Bypass permissions\./)).toBeInTheDocument();
  });

  it("a wrong-state refusal says so in words", async () => {
    reply = () => HttpResponse.json({ ok: false, code: "conflict", error: "thread-busy" }, { status: 409 });
    show();
    fireEvent.click(within(await openModeMenu()).getByRole("menuitemradio", { name: "Plan" }));
    expect(await screen.findByText("The agent is working. Change the mode when it stops.")).toBeInTheDocument();
  });

  it("an unknown mode shows as Mode; read-only disables the switch", async () => {
    show({ permissionMode: undefined });
    expect(modeTrigger()).toHaveAccessibleName("Permission mode: unknown");
    expect(modeTrigger()).toHaveTextContent("Mode");
    act(() => useBridgeInfo.setState({ readOnly: true }));
    const menu = await openModeMenu();
    expect(within(menu).getByText("This device is read-only.")).toBeInTheDocument();
    act(() => useBridgeInfo.setState({ readOnly: false }));
  });

  it("a harness with no live modes (Pi) gets no mode control", () => {
    show({ harness: "pi", capabilities: PI, permissionMode: undefined });
    expect(modeTrigger()).toBeNull();
  });
});

describe("ChatComposer: Stop and Steer come from the flags", () => {
  it("a working Pi thread shows Stop, and Steer for a follow-up", async () => {
    act(() => setFollowUp("steer"));
    show({ harness: "pi", capabilities: PI, status: "working", permissionMode: undefined });
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "change course" } });
    expect(document.querySelector("[data-primary-kind]")).toHaveAccessibleName("Steer");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(commands("run.interrupt")).toEqual([expect.objectContaining({ threadId: "t1" })]));
    act(() => setFollowUp("queue"));
  });
});

describe("ChatComposer: staged images", () => {
  it("an image chip shows a thumbnail button that opens the viewer; a text file does not", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:shot"), revokeObjectURL: vi.fn() }));
    server.use(http.post("/api/pane/:paneId/upload", () => HttpResponse.json({ ok: true, path: "C:/up/x" })));
    show();
    const input = screen.getByTestId("attach-input");
    fireEvent.change(input, { target: { files: [new File(["png"], "shot.png", { type: "image/png" }), new File(["a"], "a.txt", { type: "text/plain" })] } });
    const view = await screen.findByRole("button", { name: "View shot.png" });
    expect(screen.queryByRole("button", { name: "View a.txt" })).toBeNull();
    fireEvent.click(view);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("region", { name: "shot.png, zoomable image" })).toBeInTheDocument();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close image preview" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:shot");
  });
});

describe("ChatComposer: prompt length", () => {
  it("says so once the text reaches the cap", () => {
    show();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "x".repeat(MAX_COMPOSER_CHARS) } });
    expect(screen.getByRole("alert")).toHaveTextContent("At the 64 KB limit. Attach longer text as a file.");
  });
});

describe("ChatComposer: snoozed and settled line (ThreadStatusLine)", () => {
  it("snoozed: says when it wakes, and Wake now posts thread.unsnooze", async () => {
    show({ shelf: "snoozed", snoozedUntil: Date.now() + 2 * 3_600_000 });
    expect(screen.getByText("Snoozed, wakes in 2h")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Wake now" }));
    await waitFor(() => expect(commands("thread.unsnooze")).toEqual([expect.objectContaining({ threadId: "t1" })]));
  });

  it("settled: says how long ago, and Un-settle posts thread.unsettle", async () => {
    show({ shelf: "settled", settledAt: Date.now() - 3 * 3_600_000 });
    expect(screen.getByText("Settled 3h ago")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Un-settle" }));
    await waitFor(() => expect(commands("thread.unsettle")).toEqual([expect.objectContaining({ threadId: "t1" })]));
  });

  it("an active thread has no status line", () => {
    show();
    expect(document.querySelector("[data-chat-thread-status-line]")).toBeNull();
  });
});
