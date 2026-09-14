import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DisplayPrefsContent } from "./display-prefs";
import { setDesktop, __resetDesktop } from "@/lib/desktop";

afterEach(() => { cleanup(); __resetDesktop(); });
const props = { prefs: { fontSize: 12, rawTerminal: true, tapToFocus: true, showTerminal: true, showThinking: true }, stepFontSize: () => {}, setRawTerminal: () => {}, setTapToFocus: () => {}, setShowTerminal: () => {}, setShowThinking: () => {} };
describe("display preferences in desktop mode", () => {
  it("keeps Tap to type on phones", () => { render(<DisplayPrefsContent {...props} />); expect(screen.getByText("Tap to type")).toBeInTheDocument(); });
  it("hides Tap to type on desktop but keeps Raw terminal", () => { setDesktop(true); render(<DisplayPrefsContent {...props} />); expect(screen.queryByText("Tap to type")).toBeNull(); expect(screen.getByText("Raw terminal")).toBeInTheDocument(); });
  it("Show terminal switch moved to the composer's Terminal toggle", () => {
    render(<DisplayPrefsContent {...props} />);
    expect(screen.queryByRole("switch", { name: "Show terminal" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Raw terminal" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Show thinking" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decrease font size" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Increase font size" })).toBeInTheDocument();
    cleanup();
    setDesktop(true);
    render(<DisplayPrefsContent {...props} />);
    expect(screen.queryByRole("switch", { name: "Show terminal" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Raw terminal" })).toBeInTheDocument();
  });
});
