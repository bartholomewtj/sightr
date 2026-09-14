import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { Composer } from "./composer";
import { __resetDesktop, setDesktop } from "@/lib/desktop";
import type { PromptSelectBlock } from "@/lib/blocks";
import type { ComposerHandle } from "./composer";
import { clearStatus, useStatus } from "@/lib/status";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";

const prompt = (feedback?: PromptSelectBlock["prompt"]["feedback"]): PromptSelectBlock => ({
  kind: "prompt-select",
  lines: [],
  prompt: {
    question: "Continue?",
    options: [{ label: "Yes", keys: ["1"] }, { label: "No", keys: ["2"] }],
    family: "permission",
    coreSignature: "core",
    signature: "screen",
    feedback,
  },
});

function Status() { const value = useStatus(); return <output data-testid="status">{value?.text ?? ""}</output>; }

function mount(overrides: Partial<React.ComponentProps<typeof Composer>> = {}, ref = createRef<ComposerHandle>()) {
  const props: React.ComponentProps<typeof Composer> = {
    paneId: "p1", agent: "claude", isShell: false, gone: false, readOnly: false,
    dialogPresent: false, text: "screen", terminalDraft: null, rawTerminalDraft: null,
    prefs: { fontSize: 11, rawTerminal: false, tapToFocus: true, showTerminal: true, showThinking: true }, stepFontSize: () => {},
    setRawTerminal: () => {}, setTapToFocus: () => {}, setShowTerminal: () => {}, setShowThinking: () => {}, onSent: () => {}, ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <><Status /><Composer ref={ref} {...props} /></> }]);
  render(<RouterProvider router={router} />);
  return screen.getByPlaceholderText(/type a reply/i);
}

beforeEach(() => { __resetDesktop(); clearStatus(); });
afterEach(() => { cleanup(); __resetDesktop(); });

describe("desktop prompt number keys", () => {
  it("routes a matching empty-box digit through the prompt action", async () => {
    setDesktop(true);
    const action = vi.fn().mockResolvedValue(true);
    const rawKeys: string[][] = [];
    server.use(http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
      rawKeys.push(((await request.json()) as { keys: string[] }).keys);
      return HttpResponse.json({ ok: true });
    }));
    const box = mount({ dialogPresent: true, promptBlock: prompt(), onPromptAction: action });
    fireEvent.keyDown(box, { key: "1" });
    await waitFor(() => expect(action).toHaveBeenCalledWith(
      { kind: "option", option: { label: "Yes", keys: ["1"] } },
      expect.objectContaining({ question: "Continue?" }),
    ));
    expect(rawKeys).toEqual([]);
  });

  it("reports an unknown option without sending raw keys", () => {
    setDesktop(true);
    const action = vi.fn();
    const rawKeys: string[][] = [];
    server.use(http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
      rawKeys.push(((await request.json()) as { keys: string[] }).keys);
      return HttpResponse.json({ ok: true });
    }));
    const box = mount({ dialogPresent: true, promptBlock: prompt(), onPromptAction: action });
    fireEvent.keyDown(box, { key: "9" });
    expect(action).not.toHaveBeenCalled();
    expect(rawKeys).toEqual([]);
    expect(screen.getByTestId("status")).toHaveTextContent("No option 9");
  });

  it("does not answer an unfocused plan text row", () => {
    setDesktop(true);
    const action = vi.fn();
    const box = mount({ dialogPresent: true, promptBlock: prompt({ key: "3", focused: false, text: "" }), onPromptAction: action });
    fireEvent.keyDown(box, { key: "3" });
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByTestId("status")).toHaveTextContent("No option 3");
  });

  it("does not answer a focused plan text row", () => {
    setDesktop(true);
    const action = vi.fn();
    const box = mount({ dialogPresent: true, promptBlock: prompt({ key: "3", focused: true, text: "" }), onPromptAction: action });
    fireEvent.keyDown(box, { key: "1" });
    expect(action).not.toHaveBeenCalled();
    expect(screen.getByTestId("status")).toHaveTextContent("Use the buttons for this dialog");
  });

  it("uses the generic dialog status when no prompt block is available", () => {
    setDesktop(true);
    const box = mount({ dialogPresent: true });
    fireEvent.keyDown(box, { key: "1" });
    expect(screen.getByTestId("status")).toHaveTextContent("Use the buttons for this dialog");
  });

  it("leaves digits to direct typing when armed", () => {
    setDesktop(true);
    const action = vi.fn();
    const ref = createRef<ComposerHandle>();
    const box = mount({ promptBlock: prompt(), onPromptAction: action }, ref);
    ref.current?.armDirect();
    fireEvent.keyDown(box, { key: "1" });
    expect(action).not.toHaveBeenCalled();
  });

  it("types digits normally when no dialog is present", async () => {
    setDesktop(true);
    const box = mount();
    await userEvent.setup().type(box, "1");
    expect(box).toHaveValue("1");
  });

  it("types digits normally when the box is non-empty", async () => {
    setDesktop(true);
    const action = vi.fn();
    const box = mount({ promptBlock: prompt(), onPromptAction: action });
    await userEvent.setup().type(box, "x1");
    expect(box).toHaveValue("x1");
    expect(action).not.toHaveBeenCalled();
  });

  it("leaves digits untouched when desktop mode is off", async () => {
    setDesktop(false);
    const action = vi.fn();
    const box = mount({ promptBlock: prompt(), onPromptAction: action });
    await userEvent.setup().type(box, "1");
    expect(box).toHaveValue("1");
    expect(action).not.toHaveBeenCalled();
  });
});
