import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Composer } from "./composer";
import { __resetDesktop, setDesktop } from "@/lib/desktop";
import { server } from "@/test/setup";
import { recordReply } from "@/test/handlers";
import { clearStatus, useStatus } from "@/lib/status";
import { pickMore } from "@/test/composer-menu";

function replyHandler(onTyped: (text: string) => void, onSubmit?: () => void) {
  return http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
    const body = (await request.json()) as { text: string; submit?: boolean };
    recordReply(body);
    if (body.submit) onSubmit?.();
    else onTyped(body.text);
    return HttpResponse.json({ ok: true });
  });
}

function StatusSentinel() { const status = useStatus(); return <output data-testid="status">{status?.text ?? ""}</output>; }

function mount(overrides: Partial<React.ComponentProps<typeof Composer>> = {}, withStatus = false) {
  const props: React.ComponentProps<typeof Composer> = {
    paneId: "w1:p1", agent: "claude", isShell: false, gone: false, readOnly: false,
    dialogPresent: false, text: "output", terminalDraft: null, rawTerminalDraft: null,
    prefs: { fontSize: 11, rawTerminal: false, tapToFocus: true, showTerminal: true, showThinking: true }, stepFontSize: () => {},
    setRawTerminal: () => {}, setTapToFocus: () => {}, setShowTerminal: () => {}, setShowThinking: () => {}, onSent: () => {}, ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: withStatus ? <><StatusSentinel /><Composer {...props} /></> : <Composer {...props} /> }]);
  render(<RouterProvider router={router} />);
  return screen.getByPlaceholderText(/type a reply|type a shell command/i);
}

beforeEach(() => { localStorage.clear(); __resetDesktop(); clearStatus(); });
afterEach(() => { cleanup(); __resetDesktop(); });

describe("desktop composer behavior", () => {
  it("shows shortcut hints for reply and shell placeholders", () => {
    setDesktop(true);
    mount();
    expect(screen.getByPlaceholderText(/Enter sends.*Shift\+Enter.*Ctrl\+`/)).toBeInTheDocument();
    cleanup();
    mount({ isShell: true });
    expect(screen.getByPlaceholderText(/Type a shell command.*Enter sends.*Shift\+Enter.*Ctrl\+`/)).toBeInTheDocument();
  });

  it("does not render a Quick button", () => {
    setDesktop(true);
    mount();
    expect(screen.queryByRole("button", { name: "Quick" })).not.toBeInTheDocument();
  });

  it("does not render the gesture wheel handle", () => {
    setDesktop(true);
    mount();
    expect(screen.queryByRole("button", { name: "Shortcut wheel" })).not.toBeInTheDocument();
  });

  it("keeps phone Enter as a newline and does not prevent it", async () => {
    setDesktop(false);
    const replies: string[] = [];
    server.use(replyHandler((text) => replies.push(text)));
    const box = mount();
    const user = userEvent.setup();
    await user.type(box, "hello");
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(true);
    await user.type(box, "{enter}");
    expect(box).toHaveValue("hello\n");
    expect(replies).toEqual([]);
  });

  it("keeps phone draft refusal and its status", () => {
    setDesktop(false);
    const box = mount({}, true);
    fireEvent.change(box, { target: { value: "draft" } });
    pickMore("Type into terminal");
    expect(screen.getByTestId("status")).toHaveTextContent("Send or clear the draft before typing into the terminal.");
  });

  it("sends desktop Enter and uses Shift+Enter for a newline", async () => {
    setDesktop(true);
    const replies: string[] = [];
    let submits = 0;
    server.use(replyHandler((text) => replies.push(text), () => submits++));
    const box = mount();
    const user = userEvent.setup();
    await user.type(box, "hello");
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(false);
    await waitFor(() => expect(box).toHaveValue(""));
    expect(replies).toEqual(["hello"]);
    await waitFor(() => expect(submits).toBe(1));

    await user.type(box, "line");
    await user.type(box, "{shift>}{enter}{/shift}");
    expect(box).toHaveValue("line\n");
    expect(replies).toEqual(["hello"]);
  });

  it("keeps Ctrl+Enter sending", async () => {
    setDesktop(true);
    const replies: string[] = [];
    server.use(replyHandler((text) => replies.push(text)));
    const box = mount();
    await userEvent.setup().type(box, "ctrl");
    expect(fireEvent.keyDown(box, { key: "Enter", ctrlKey: true })).toBe(false);
    await waitFor(() => expect(box).toHaveValue(""));
    expect(replies).toEqual(["ctrl"]);
  });

  it("does nothing for Enter while composing", async () => {
    setDesktop(true);
    const replies: string[] = [];
    server.use(replyHandler((text) => replies.push(text)));
    const box = mount();
    await userEvent.setup().type(box, "ctrl");
    const composing = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    Object.defineProperty(composing, "isComposing", { value: true });
    box.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(box).toHaveValue("ctrl");
    expect(replies).toEqual([]);
  });

  it("passes empty navigation keys through and never Ctrl+C", async () => {
    setDesktop(true);
    const keys: string[][] = [];
    server.use(http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
      keys.push(((await request.json()) as { keys: string[] }).keys); return HttpResponse.json({ ok: true });
    }));
    const box = mount();
    for (const [key, expected] of [["Escape", "Escape"], ["Tab", "Tab"], ["ArrowUp", "Up"], ["ArrowDown", "Down"], ["ArrowLeft", "Left"], ["ArrowRight", "Right"]]) {
      fireEvent.keyDown(box, { key });
      await waitFor(() => expect(keys).toContainEqual([expected]));
    }
    expect(fireEvent.keyDown(box, { key: "Tab", shiftKey: true })).toBe(false);
    await waitFor(() => expect(keys).toContainEqual(["shift+Tab"]));
    expect(fireEvent.keyDown(box, { key: "ArrowUp", shiftKey: true })).toBe(true);
    const copy = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, cancelable: true });
    box.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(false);
    expect(keys).toHaveLength(7);
  });

  it("does not pass editing keys through when non-empty", () => {
    setDesktop(true);
    const keys: string[][] = [];
    server.use(http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
      keys.push(((await request.json()) as { keys: string[] }).keys); return HttpResponse.json({ ok: true });
    }));
    const box = mount();
    fireEvent.change(box, { target: { value: "text" } });
    expect(fireEvent.keyDown(box, { key: "Escape" })).toBe(true);
    expect(fireEvent.keyDown(box, { key: "ArrowUp" })).toBe(true);
    expect(keys).toEqual([]);
  });

  it("keeps destructive sends behind the two-tap confirm", async () => {
    setDesktop(true);
    const replies: string[] = [];
    server.use(replyHandler((text) => replies.push(text)));
    const box = mount({}, true); const user = userEvent.setup();
    await user.type(box, "rm -rf /tmp/x");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByTestId("status")).toHaveTextContent(/Destructive: .*tap Send again/);
    expect(replies).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Really send?" }));
    await waitFor(() => expect(replies).toEqual(["rm -rf /tmp/x"]));
  });

  it("does not send or prevent an IME Enter", () => {
    setDesktop(true);
    const box = mount();
    const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    Object.defineProperty(event, "isComposing", { value: true });
    box.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
