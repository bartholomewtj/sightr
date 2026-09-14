import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import type { WorkspaceView } from "@/lib/types";
import { SssfFrame, sssfFrameSrc } from "./sssf-frame";

const ws: WorkspaceView = {
  workspaceId: "w1",
  number: 1,
  label: "home",
  focused: false,
  activeTabId: "t1",
  tabCount: 1,
  paneCount: 1,
};

describe("sssfFrameSrc — what the bridge and the visualiser read off the frame URL", () => {
  it("carries ws, token and embed; repo only when given; the hash is the visualiser route", () => {
    expect(sssfFrameSrc("w1", "tok")).toBe("/sssf/?ws=w1&t=tok&embed=1#/");
    expect(sssfFrameSrc("w1", "tok", "sightr", "e7b38c61")).toBe("/sssf/?ws=w1&t=tok&embed=1&repo=sightr#/e7b38c61");
  });

  it("encodes the run id into the hash rather than trusting it", () => {
    expect(sssfFrameSrc("w1", "tok", "r", "a/b#c")).toBe("/sssf/?ws=w1&t=tok&embed=1&repo=r#/a%2Fb%23c");
  });
});

describe("SssfFrame — the run to open on is pinned at mount", () => {
  it("keeps the first adwId even when the prop later changes; a repo/token change still flows through", () => {
    const sssf = { state: "ready" as const, token: "tok", repos: [] };
    const { rerender } = render(<SssfFrame workspace={ws} sssf={sssf} repo="a" adwId="run1" />);
    const frame = () => screen.getByTitle("SSSF traces — home") as HTMLIFrameElement;
    expect(frame().getAttribute("src")).toBe("/sssf/?ws=w1&t=tok&embed=1&repo=a#/run1");
    rerender(<SssfFrame workspace={ws} sssf={{ ...sssf, token: "tok2" }} repo="a" adwId="run2" />);
    expect(frame().getAttribute("src")).toBe("/sssf/?ws=w1&t=tok2&embed=1&repo=a#/run1");
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("is a plain iframe filling the pane — no zoom overlay, no forced desktop width", () => {
    const sssf = { state: "ready" as const, token: "tok", repos: [] };
    render(<SssfFrame workspace={ws} sssf={sssf} repo="a" />);
    const frame = screen.getByTitle("SSSF traces — home");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveClass("w-full");
    expect(frame).not.toHaveClass("min-w-[1200px]");
    expect(screen.queryByTestId("sssf-zoom-overlay")).toBeNull();
    expect(screen.queryByRole("group", { name: /pinch to zoom/i })).toBeNull();
  });
});
