import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { __resetDesktop, desktopPrefs, setDesktop, setLayout, setSidebarPx, setTyping } from "./desktop";

describe("desktop preferences", () => {
  beforeEach(() => __resetDesktop());
  afterEach(() => __resetDesktop());

  it("has the phone-safe defaults", () => {
    expect(desktopPrefs()).toMatchInlineSnapshot(`
      {
        "layout": "system",
        "on": false,
        "sidebarPx": 280,
        "typing": "composer",
      }
    `);
  });
  it("persists both preferences", () => {
    setDesktop(true);
    setTyping("direct");
    expect(desktopPrefs()).toEqual({ layout: "on", on: true, sidebarPx: 280, typing: "direct" });
    expect(localStorage.getItem("sightr:desktop:v2")).toContain("direct");
  });
  it("maps the old payload and removes its key", () => {
    localStorage.setItem("sightr:desktop:v1", JSON.stringify({ on: true, typing: "direct" }));
    expect(desktopPrefs().layout).toBe("on");
    expect(localStorage.getItem("sightr:desktop:v1")).toBeNull();
    expect(localStorage.getItem("sightr:desktop:v2")).toContain('"layout":"on"');
  });
  it("maps an old false payload to System", () => {
    localStorage.setItem("sightr:desktop:v1", JSON.stringify({ on: false }));
    expect(desktopPrefs().layout).toBe("system");
  });
  it("clamps and persists the sidebar width", () => {
    setSidebarPx(100);
    expect(desktopPrefs().sidebarPx).toBe(200);
    setSidebarPx(600);
    expect(desktopPrefs().sidebarPx).toBe(480);
    expect(localStorage.getItem("sightr:desktop:v2")).toContain('"sidebarPx":480');
  });
  it("treats a false or missing matchMedia result as phone layout", () => {
    const original = window.matchMedia;
    try {
      vi.stubGlobal("matchMedia", () => ({ matches: false }));
      expect(desktopPrefs().on).toBe(false);
      vi.stubGlobal("matchMedia", undefined);
      __resetDesktop();
      expect(desktopPrefs().on).toBe(false);
    } finally { window.matchMedia = original; }
  });
  it("lets a pinned layout override the system query", () => {
    const original = window.matchMedia;
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    try {
      setLayout("system");
      expect(desktopPrefs().on).toBe(true);
      setDesktop(false);
      expect(desktopPrefs().on).toBe(false);
    } finally { window.matchMedia = original; }
  });
});
