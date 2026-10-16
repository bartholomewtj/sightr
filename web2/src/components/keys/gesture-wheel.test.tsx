import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { act } from "react";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { NO_CAPABILITIES, type RuntimeRequest } from "@shared/v2/contracts";
import { ctrlPresetsFor } from "@v1/lib/operator-keys";
import { HOLD_MS, layoutSlices, wheelChoices } from "@v1/lib/wheel";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { WheelPrefsControl } from "@/components/settings/WheelPrefsControl";
import { STORAGE_KEY } from "@/hooks/use-wheel-prefs";
import { useRightPanelStore } from "@/rightPanelStore";
import { threadFromSnapshot } from "@/stream/apply";
import { useStreamHealth, useThreadStore } from "@/stream/stores";
import { thread as threadFixture } from "@/test/fixtures";
import { setViewportWidth } from "@/test/media";
import { server } from "@/test/setup";

// T19: the phone composer's gesture wheel, copied from v1, beside Send.

let keyPosts: { paneId: string; body: { keys: string[] } }[] = [];

beforeAll(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
});

beforeEach(() => {
  keyPosts = [];
  setViewportWidth(390);
  server.use(
    http.post("/api/pane/:paneId/keys", async ({ request, params }) => {
      keyPosts.push({ paneId: String(params.paneId), body: (await request.json()) as { keys: string[] } });
      return HttpResponse.json({ ok: true });
    }),
  );
  useStreamHealth.setState({ status: "live" });
});

const SIX = wheelChoices(ctrlPresetsFor("claude", [])).slice(0, 6);

function show(requests: RuntimeRequest[] = []) {
  useThreadStore.setState({
    current: threadFromSnapshot(
      {
        sequence: 1,
        thread: threadFixture("t1", { capabilities: { ...NO_CAPABILITIES, hasJournal: true } }),
        runs: [],
        items: [],
        requests,
        queue: [],
        historyCursor: null,
      },
      false,
    ),
    missing: null,
  });
  return render(<ChatComposer threadId="t1" />);
}

const ORIGIN = { x: 300, y: 700 };

async function holdOpen(): Promise<HTMLElement> {
  const handle = screen.getByRole("button", { name: "Shortcut wheel" });
  fireEvent.pointerDown(handle, { clientX: ORIGIN.x, clientY: ORIGIN.y, pointerId: 1, button: 0 });
  await act(async () => {
    await new Promise((r) => setTimeout(r, HOLD_MS + 80));
  });
  return handle;
}

function releaseOn(handle: HTMLElement, index: number, count: number): void {
  const pt = layoutSlices(count)[index]!;
  const at = { clientX: ORIGIN.x + pt.dx, clientY: ORIGIN.y + pt.dy, pointerId: 1 };
  fireEvent.pointerMove(handle, at);
  fireEvent.pointerUp(handle, at);
}

describe("GestureWheel in the composer", () => {
  it("hold fans six slices; release on a key slice sends its keys through the dock's sender", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ picks: SIX.map((c) => c.id) }));
    show();
    const handle = await holdOpen();
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(6);
    expect(items.map((i) => i.getAttribute("aria-label"))).toEqual(SIX.map((c) => c.slice.label));
    const enter = SIX.findIndex((c) => c.id === "keys:Enter");
    releaseOn(handle, enter, 6);
    await waitFor(() => expect(keyPosts).toHaveLength(1));
    expect(keyPosts[0]).toEqual({ paneId: "p-t1", body: { keys: ["Enter"] } });
  });

  it("the Type slice opens the Terminal tab with direct typing armed", async () => {
    show();
    const handle = await holdOpen();
    // The shipped wheel: Esc, Tab, Enter, Type.
    expect(screen.getAllByRole("menuitem")).toHaveLength(4);
    releaseOn(handle, 3, 4);
    await waitFor(() => expect(useRightPanelStore.getState().sheet).toBe("terminal"));
    expect(useRightPanelStore.getState().directTyping).toMatchObject({ threadId: "t1" });
    expect(keyPosts).toHaveLength(0);
  });

  it("a plain tap toggles the Keys dock", async () => {
    show();
    const handle = screen.getByRole("button", { name: "Shortcut wheel" });
    fireEvent.pointerDown(handle, { clientX: ORIGIN.x, clientY: ORIGIN.y, pointerId: 1, button: 0 });
    fireEvent.pointerUp(handle, { clientX: ORIGIN.x, clientY: ORIGIN.y, pointerId: 1 });
    await waitFor(() => expect(document.querySelector("[data-keys-dock]")).not.toBeNull());
  });

  it("is not there while a request is pending (the panel owns the area), nor on a desktop", () => {
    const pending: RuntimeRequest = {
      id: "r1",
      threadId: "t1",
      kind: "permission",
      prompt: "Run it?",
      options: [{ label: "Yes", keys: ["1"] }],
      status: "pending",
      bindingHash: "h",
      createdAt: 1,
      updatedAt: 1,
    };
    const { unmount } = show([pending]);
    expect(screen.queryByRole("button", { name: "Shortcut wheel" })).toBeNull();
    unmount();
    setViewportWidth(1280);
    show();
    expect(screen.queryByRole("button", { name: "Shortcut wheel" })).toBeNull();
  });
});

describe("WheelPrefsControl (the Settings picker)", () => {
  it("round-trips: a flip starts a custom wheel from the defaults, survives a remount, and resets", () => {
    const { unmount } = render(<WheelPrefsControl />);
    expect(screen.getByText("This is the default wheel. Flip any switch to make your own, up to six.")).toBeInTheDocument();
    // Turn Tab off: the custom wheel is the defaults minus Tab.
    fireEvent.click(screen.getByRole("switch", { name: "Tab" }));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ picks: ["keys:Escape", "keys:Enter", "type"] });
    unmount();
    render(<WheelPrefsControl />);
    expect(screen.getByRole("switch", { name: "Tab" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Esc" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Use the default wheel" }));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({ picks: [] });
    expect(screen.getByRole("switch", { name: "Tab" })).toBeChecked();
  });
});
