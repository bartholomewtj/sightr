import { describe, expect, it } from "vitest";

import { setViewportWidth } from "@/test/media";

import {
  __resetRightPanelStore,
  clampRightPanelWidth,
  clampTerminalFont,
  openRightPanelSurface,
  RIGHT_PANEL_MAX,
  RIGHT_PANEL_MIN,
  toggleRightPanelSurface,
  useRightPanelStore,
} from "./rightPanelStore";

describe("rightPanelStore", () => {
  it("opens a tab in the desktop panel, and a sheet on a phone", () => {
    setViewportWidth(1280);
    openRightPanelSurface("git");
    expect(useRightPanelStore.getState()).toMatchObject({ isOpen: true, activeSurfaceId: "git", sheet: null });
    toggleRightPanelSurface("git");
    expect(useRightPanelStore.getState().isOpen).toBe(false);
    setViewportWidth(390);
    openRightPanelSurface("files");
    expect(useRightPanelStore.getState().sheet).toBe("files");
    toggleRightPanelSurface("files");
    expect(useRightPanelStore.getState().sheet).toBeNull();
  });

  it("persists open state, tab, width and font per device, never the sheet", () => {
    const s = useRightPanelStore.getState();
    s.open("files");
    s.setWidth(500);
    s.setTerminalFontSize(14);
    s.openSheet("git");
    const stored = JSON.parse(localStorage.getItem("sightr:v2:right-panel-state:v1") ?? "{}").state;
    expect(stored).toEqual({ isOpen: true, activeSurfaceId: "git", width: 500, terminalFontSize: 14 });
    __resetRightPanelStore();
    expect(useRightPanelStore.getState()).toMatchObject({ activeSurfaceId: "git", width: 500, terminalFontSize: 14, sheet: null });
  });

  it("clamps width and font, and ignores junk in storage", () => {
    expect(clampRightPanelWidth(10)).toBe(RIGHT_PANEL_MIN);
    expect(clampRightPanelWidth(5_000)).toBe(RIGHT_PANEL_MAX);
    expect(clampTerminalFont(4)).toBe(10);
    expect(clampTerminalFont(40)).toBe(16);
    localStorage.setItem("sightr:v2:right-panel-state:v1", JSON.stringify({ state: { activeSurfaceId: "preview", width: "wide" }, version: 1 }));
    __resetRightPanelStore();
    expect(useRightPanelStore.getState()).toMatchObject({ activeSurfaceId: "terminal", width: 420 });
  });

  it("hands one direct-typing request to the Terminal tab", () => {
    useRightPanelStore.getState().requestDirectTyping("t1", "Password:");
    const req = useRightPanelStore.getState().directTyping!;
    expect(req).toMatchObject({ threadId: "t1", prompt: "Password:" });
    useRightPanelStore.getState().consumeDirectTyping(req.id + 1);
    expect(useRightPanelStore.getState().directTyping).not.toBeNull();
    useRightPanelStore.getState().consumeDirectTyping(req.id);
    expect(useRightPanelStore.getState().directTyping).toBeNull();
  });
});
