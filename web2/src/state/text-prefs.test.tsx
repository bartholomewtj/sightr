import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import ChatMarkdown from "@/components/ChatMarkdown";
import { DisplaySettings } from "@/components/settings/DisplaySettings";
import { setViewportWidth } from "@/test/media";

import { __resetTextPrefs, codeStartsWrapped, getTextPrefs, parseTextPrefs, setTextPref, TEXT_PREFS_KEY } from "./text-prefs";

beforeEach(() => {
  document.documentElement.style.fontSize = "";
});

describe("parseTextPrefs", () => {
  it("falls back to 100% and auto for anything not offered", () => {
    expect(parseTextPrefs(null)).toEqual({ textScale: 100, codeWrap: "auto" });
    expect(parseTextPrefs({ textScale: 333, codeWrap: "sideways" })).toEqual({ textScale: 100, codeWrap: "auto" });
    expect(parseTextPrefs({ textScale: 130, codeWrap: "scroll" })).toEqual({ textScale: 130, codeWrap: "scroll" });
  });

  it("auto wraps on a phone only; wrap and scroll are fixed", () => {
    expect(codeStartsWrapped("auto", true)).toBe(true);
    expect(codeStartsWrapped("auto", false)).toBe(false);
    expect(codeStartsWrapped("wrap", false)).toBe(true);
    expect(codeStartsWrapped("scroll", true)).toBe(false);
  });
});

describe("text size", () => {
  it("sets the root font size, stores it, and a reload reads it back", () => {
    setTextPref("textScale", 115);
    expect(document.documentElement.style.fontSize).toBe("115%");
    expect(JSON.parse(localStorage.getItem(TEXT_PREFS_KEY)!)).toEqual({ textScale: 115, codeWrap: "auto" });
    document.documentElement.style.fontSize = "";
    __resetTextPrefs();
    expect(getTextPrefs().textScale).toBe(115);
    expect(document.documentElement.style.fontSize).toBe("115%");
  });

  it("100% leaves the root size to the browser", () => {
    setTextPref("textScale", 130);
    setTextPref("textScale", 100);
    expect(document.documentElement.style.fontSize).toBe("");
  });

  it("the Settings row changes it and marks the choice", () => {
    render(<DisplaySettings />);
    expect(screen.getByRole("radio", { name: "100%" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "130%" }));
    expect(document.documentElement.style.fontSize).toBe("130%");
    expect(screen.getByRole("radio", { name: "130%" })).toHaveAttribute("aria-checked", "true");
  });

  it("the Terminal tab keeps its own size control", () => {
    render(<DisplaySettings />);
    expect(screen.getByTestId("terminal-font-size")).toHaveTextContent("12px");
    fireEvent.click(screen.getByRole("button", { name: "Increase terminal text size" }));
    expect(screen.getByTestId("terminal-font-size")).toHaveTextContent("13px");
    expect(document.documentElement.style.fontSize).toBe("");
  });
});

describe("code wrapping", () => {
  const frame = () => document.querySelector(".chat-markdown-codeblock")!.getAttribute("data-wrap");
  const code = "```ts\nconst a = 1;\n```";

  it("auto: wrapped on a phone, scrolling on a wide screen (as before)", () => {
    setViewportWidth(390);
    const first = render(<ChatMarkdown text={code} />);
    expect(frame()).toBe("true");
    first.unmount();
    setViewportWidth(1280);
    render(<ChatMarkdown text={code} />);
    expect(frame()).toBe("false");
  });

  it("scroll: a phone's blocks start unwrapped, and the block's own button still wraps one", () => {
    setViewportWidth(390);
    setTextPref("codeWrap", "scroll");
    render(<ChatMarkdown text={code} />);
    expect(frame()).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Wrap lines" }));
    expect(frame()).toBe("true");
  });

  it("wrap: a wide screen's blocks start wrapped", () => {
    setViewportWidth(1280);
    setTextPref("codeWrap", "wrap");
    render(<ChatMarkdown text={code} />);
    expect(frame()).toBe("true");
  });

  it("the Settings row sets it", () => {
    render(<DisplaySettings />);
    fireEvent.click(screen.getByRole("radio", { name: "Scroll" }));
    expect(getTextPrefs().codeWrap).toBe("scroll");
    expect(JSON.parse(localStorage.getItem(TEXT_PREFS_KEY)!).codeWrap).toBe("scroll");
  });
});
