import { describe, expect, it } from "vitest";

import { setViewportWidth } from "@/test/media";

import {
  __resetRightPanelStore,
  clampRightPanelWidth,
  clampTerminalFont,
  openRightPanelSurface,
  RIGHT_PANEL_KINDS,
  RIGHT_PANEL_LABEL,
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

  it("has four tabs, with Diff appended so a saved tab id from before stays valid", () => {
    expect([...RIGHT_PANEL_KINDS]).toEqual(["terminal", "files", "git", "diff"]);
    expect(RIGHT_PANEL_LABEL.diff).toBe("Diff");
    for (const saved of ["terminal", "files", "git", "diff"]) {
      localStorage.setItem("sightr:v2:right-panel-state:v1", JSON.stringify({ state: { activeSurfaceId: saved }, version: 1 }));
      __resetRightPanelStore();
      expect(useRightPanelStore.getState().activeSurfaceId).toBe(saved);
    }
    setViewportWidth(1280);
    openRightPanelSurface("diff");
    expect(useRightPanelStore.getState()).toMatchObject({ isOpen: true, activeSurfaceId: "diff", sheet: null });
    toggleRightPanelSurface("diff");
    expect(useRightPanelStore.getState().isOpen).toBe(false);
    setViewportWidth(390);
    openRightPanelSurface("diff");
    expect(useRightPanelStore.getState().sheet).toBe("diff");
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

  it("keeps a Wrap choice per device, and follows the layout until one is made", () => {
    useRightPanelStore.getState().setDiffWrap(false);
    expect(JSON.parse(localStorage.getItem("sightr:v2:right-panel-state:v1") ?? "{}").state.diffWrap).toBe(false);
    __resetRightPanelStore();
    expect(useRightPanelStore.getState().diffWrap).toBe(false);
    localStorage.setItem("sightr:v2:right-panel-state:v1", JSON.stringify({ state: { diffWrap: "yes" }, version: 1 }));
    __resetRightPanelStore();
    expect(useRightPanelStore.getState().diffWrap).toBeNull();
  });

  it("keeps the Diff layout and Ignore whitespace per device, ignores wrong types, and leaves Wrap alone", () => {
    const KEY = "sightr:v2:right-panel-state:v1";
    const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "{}").state;
    expect(useRightPanelStore.getState()).toMatchObject({ diffLayout: null, diffIgnoreWhitespace: false });
    useRightPanelStore.getState().setDiffLayout("split");
    useRightPanelStore.getState().setDiffIgnoreWhitespace(true);
    expect(stored()).toMatchObject({ diffLayout: "split", diffIgnoreWhitespace: true });
    expect(stored().diffWrap).toBeUndefined();
    __resetRightPanelStore();
    expect(useRightPanelStore.getState()).toMatchObject({ diffLayout: "split", diffIgnoreWhitespace: true, diffWrap: null });
    useRightPanelStore.getState().setDiffIgnoreWhitespace(false);
    expect(stored().diffIgnoreWhitespace).toBeUndefined();
    localStorage.setItem(KEY, JSON.stringify({ state: { diffLayout: "wide", diffIgnoreWhitespace: "yes", diffWrap: false }, version: 1 }));
    __resetRightPanelStore();
    expect(useRightPanelStore.getState()).toMatchObject({ diffLayout: null, diffIgnoreWhitespace: false, diffWrap: false });
  });

  it("keeps the Diff file list choice per device: shown until hidden, a wrong type ignored", () => {
    const KEY = "sightr:v2:right-panel-state:v1";
    const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "{}").state;
    expect(useRightPanelStore.getState().diffFileList).toBe(true);
    useRightPanelStore.getState().setDiffFileList(false);
    expect(stored().diffFileList).toBe(false);
    __resetRightPanelStore();
    expect(useRightPanelStore.getState().diffFileList).toBe(false);
    useRightPanelStore.getState().setDiffFileList(true);
    expect(stored().diffFileList).toBeUndefined();
    localStorage.setItem(KEY, JSON.stringify({ state: { diffFileList: "no" }, version: 1 }));
    __resetRightPanelStore();
    expect(useRightPanelStore.getState().diffFileList).toBe(true);
  });

  it("opens the Files tab on a path for one thread, in the panel or the sheet, and hands it over once", () => {
    setViewportWidth(1280);
    useRightPanelStore.setState({ isOpen: false, activeSurfaceId: "git" });
    useRightPanelStore.getState().openFile("t1", "proj/src/a.ts");
    const req = useRightPanelStore.getState().fileRequest!;
    expect(req).toMatchObject({ threadId: "t1", path: "proj/src/a.ts", kind: "file" });
    expect(useRightPanelStore.getState()).toMatchObject({ isOpen: true, activeSurfaceId: "files", sheet: null });
    useRightPanelStore.getState().consumeFileRequest(req.id + 1);
    expect(useRightPanelStore.getState().fileRequest).not.toBeNull();
    useRightPanelStore.getState().consumeFileRequest(req.id);
    expect(useRightPanelStore.getState().fileRequest).toBeNull();
    setViewportWidth(390);
    useRightPanelStore.getState().openFile("t1", "proj", "dir");
    expect(useRightPanelStore.getState()).toMatchObject({ sheet: "files", fileRequest: { kind: "dir" } });
    // Never persisted.
    expect(JSON.parse(localStorage.getItem("sightr:v2:right-panel-state:v1") ?? "{}").state).not.toHaveProperty("fileRequest");
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
