// T29: the gesture on the diff and the editor under a range, with the real hand adapter: a click opens the editor on that
// line, shift-click extends, Mod+Enter saves, Escape cancels, a touch tap fires only when the pointer did not scroll,
// and with the editor open a second tap extends the range (a phone has no shift key).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getLineComments } from "@/state/lineComments";
import { getOpenEditor, setOpenEditor } from "@/state/commentsUi";
import { AnnotatableCodeView, DiffCommentsContext } from "./AnnotatableCodeView";

const THREAD = "t1";
const PATCH = [
  "diff --git a/src/f.ts b/src/f.ts",
  "--- a/src/f.ts",
  "+++ b/src/f.ts",
  "@@ -1,6 +1,7 @@",
  " one",
  " two",
  "-three",
  "+THREE",
  "+THREE-B",
  " four",
  " five",
  " six",
  "",
].join("\n");

function show(path = "src/f.ts", off: string | null = null) {
  return render(
    <DiffCommentsContext value={{ threadId: THREAD, off }}>
      <AnnotatableCodeView patch={PATCH.replaceAll("src/f.ts", path)} path={path} wrap eager />
    </DiffCommentsContext>,
  );
}
const gutter = (c: HTMLElement, side: "old" | "new", n: number) => Array.from(c.querySelectorAll<HTMLElement>(`[data-diff-gutter=${side}]`)).find((g) => g.textContent === String(n))!;
const ready = (c: HTMLElement) => waitFor(() => expect(c.querySelector("[data-diff-gutter]")).not.toBeNull());
const editorBox = () => screen.getByRole("textbox", { name: /^Comment on/ });
const selected = (c: HTMLElement) => Array.from(c.querySelectorAll("[data-diff-selected]")).map((r) => r.textContent ?? "");

let coarse = false;
const realMatchMedia = window.matchMedia;
beforeEach(() => {
  coarse = false;
  window.matchMedia = ((q: string) => ({ ...realMatchMedia(q), matches: coarse && /pointer:\s*coarse/.test(q) })) as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  vi.useRealTimers();
});

describe("on a desktop", () => {
  it("a click opens the editor under that line, with the line selected", async () => {
    const { container } = show();
    await ready(container);
    fireEvent.click(gutter(container, "new", 3));
    expect(editorBox()).toBeInTheDocument();
    expect(selected(container)).toHaveLength(1);
    expect(selected(container)[0]).toContain("+THREE");
    const note = container.querySelector("[data-diff-annotation=editor]")!;
    expect(note.previousElementSibling?.textContent).toContain("THREE");
    expect(screen.getByText(/Comment on new line 3/)).toBeInTheDocument();
  });

  it("shift-click extends the range from the anchor, to the last line of the range", async () => {
    const { container } = show();
    await ready(container);
    fireEvent.click(gutter(container, "new", 3));
    fireEvent.click(gutter(container, "new", 6), { shiftKey: true });
    expect(selected(container)).toHaveLength(4); // +THREE +THREE-B four five
    expect(screen.getByText(/Comment on new lines 3-6/)).toBeInTheDocument();
    const note = container.querySelector("[data-diff-annotation=editor]")!;
    expect(note.previousElementSibling?.textContent).toContain("five");
  });

  it("a plain click on another line moves the range there and keeps what was typed", async () => {
    const { container } = show();
    await ready(container);
    fireEvent.click(gutter(container, "new", 3));
    fireEvent.change(editorBox(), { target: { value: "my half note" } });
    fireEvent.click(gutter(container, "new", 7));
    expect(selected(container)).toHaveLength(1);
    expect(editorBox()).toHaveValue("my half note");
  });

  it("Mod+Enter saves the comment to the pending list and closes the editor", async () => {
    const { container } = show();
    await ready(container);
    fireEvent.click(gutter(container, "new", 3));
    fireEvent.click(gutter(container, "new", 4), { shiftKey: true });
    fireEvent.change(editorBox(), { target: { value: "Rename these." } });
    fireEvent.keyDown(editorBox(), { key: "Enter", ctrlKey: true });
    const saved = getLineComments(THREAD);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ path: "src/f.ts", side: "new", start: 3, end: 4, note: "Rename these.", quote: ["+THREE", "+THREE-B"] });
    expect(screen.queryByRole("textbox")).toBeNull();
    // The saved note shows under the range, and its lines are no longer selected.
    expect(container.querySelector("[data-diff-comment]")).toHaveTextContent("Rename these.");
    expect(selected(container)).toEqual([]);
  });

  it("Enter adds a line and does not save; Mod+Enter on an empty note does nothing", async () => {
    const { container } = show();
    await ready(container);
    fireEvent.click(gutter(container, "new", 3));
    fireEvent.keyDown(editorBox(), { key: "Enter", ctrlKey: true });
    expect(getLineComments(THREAD)).toHaveLength(0);
    fireEvent.change(editorBox(), { target: { value: "a" } });
    fireEvent.keyDown(editorBox(), { key: "Enter" });
    fireEvent.keyDown(editorBox(), { key: "Enter", shiftKey: true });
    expect(getLineComments(THREAD)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("Escape cancels without saving", async () => {
    const { container } = show();
    await ready(container);
    fireEvent.click(gutter(container, "new", 3));
    fireEvent.change(editorBox(), { target: { value: "gone" } });
    fireEvent.keyDown(editorBox(), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(getLineComments(THREAD)).toHaveLength(0);
    expect(selected(container)).toEqual([]);
  });

  it("Escape during IME composition does not cancel the editor or lose the note", async () => {
    const { container } = show();
    await ready(container);
    fireEvent.click(gutter(container, "new", 3));
    fireEvent.change(editorBox(), { target: { value: "ime note" } });
    fireEvent.keyDown(editorBox(), { key: "Escape", isComposing: true });
    expect(editorBox()).toHaveValue("ime note");
    expect(selected(container)).toHaveLength(1);
    fireEvent.keyDown(editorBox(), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Save and Cancel buttons work the same", async () => {
    const { container } = show();
    await ready(container);
    fireEvent.click(gutter(container, "old", 3));
    fireEvent.change(editorBox(), { target: { value: "removed for a reason" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(getLineComments(THREAD)[0]).toMatchObject({ side: "old", start: 3, end: 3, quote: ["-three"] });
    fireEvent.click(gutter(container, "new", 3));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(getLineComments(THREAD)).toHaveLength(1);
  });

  it("says 12 lines is the limit and stops there", async () => {
    const body = Array.from({ length: 30 }, (_, i) => ` line ${i + 1}`);
    const patch = ["diff --git a/g.ts b/g.ts", "--- a/g.ts", "+++ b/g.ts", "@@ -1,30 +1,30 @@", ...body, ""].join("\n");
    const { container } = render(
      <DiffCommentsContext value={{ threadId: THREAD, off: null }}>
        <AnnotatableCodeView patch={patch} path="g.ts" wrap eager />
      </DiffCommentsContext>,
    );
    await ready(container);
    fireEvent.click(gutter(container, "new", 2));
    fireEvent.click(gutter(container, "new", 25), { shiftKey: true });
    expect(selected(container)).toHaveLength(12);
    expect(screen.getByText("12 lines is the limit.")).toBeInTheDocument();
  });

  it("Clear range goes back to the first line", async () => {
    const { container } = show();
    await ready(container);
    fireEvent.click(gutter(container, "new", 3));
    fireEvent.click(gutter(container, "new", 6), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Clear range" }));
    expect(selected(container)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Clear range" })).toBeNull();
  });

  it("a saved note opens Edit and Delete on a tap; Edit changes the note, Delete removes it", async () => {
    const { container } = show();
    await ready(container);
    fireEvent.click(gutter(container, "new", 3));
    fireEvent.change(editorBox(), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(container.querySelector("[data-diff-comment] button")!);
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(editorBox()).toHaveValue("first");
    expect(container.querySelector("[data-diff-comment]")).toBeNull(); // the row gives way to the editor
    fireEvent.change(editorBox(), { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(getLineComments(THREAD)).toHaveLength(1);
    expect(getLineComments(THREAD)[0]!.note).toBe("second");
    fireEvent.click(container.querySelector("[data-diff-comment] button")!);
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(getLineComments(THREAD)).toHaveLength(0);
  });
});

describe("on a phone (touch)", () => {
  const touchTap = (el: Element, over: { dx?: number; dy?: number; ms?: number } = {}) => {
    fireEvent.pointerDown(el, { pointerType: "touch", clientX: 10, clientY: 10 });
    if (over.ms) vi.advanceTimersByTime(over.ms);
    fireEvent.pointerUp(el, { pointerType: "touch", clientX: 10 + (over.dx ?? 0), clientY: 10 + (over.dy ?? 0) });
  };

  beforeEach(() => {
    coarse = true;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });

  it("a tap on a line number opens the editor without raising the keyboard (no focus)", async () => {
    vi.useRealTimers();
    const { container } = show();
    await ready(container);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    touchTap(gutter(container, "new", 3), { dx: 2, dy: 1, ms: 60 });
    expect(editorBox()).toBeInTheDocument();
    expect(document.activeElement).not.toBe(editorBox());
    expect(selected(container)).toHaveLength(1);
    expect(selected(container)[0]).toContain("+THREE");
  });

  it("a tap where the pointer moved 20 px (a scroll) saves and opens nothing", async () => {
    vi.useRealTimers();
    const { container } = show();
    await ready(container);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    touchTap(gutter(container, "new", 3), { dy: 20, ms: 60 });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(selected(container)).toEqual([]);
    expect(getLineComments(THREAD)).toHaveLength(0);
    expect(getOpenEditor(THREAD)).toBeNull();
  });

  it("a long press does not fire", async () => {
    vi.useRealTimers();
    const { container } = show();
    await ready(container);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    touchTap(gutter(container, "new", 3), { ms: 700 });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(getOpenEditor(THREAD)).toBeNull();
  });

  it("with the editor open, a second tap on another number extends the range (no shift key on a phone)", async () => {
    vi.useRealTimers();
    const { container } = show();
    await ready(container);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    touchTap(gutter(container, "new", 3), { ms: 50 });
    vi.advanceTimersByTime(700); // past the swallow window for the first tap's click
    touchTap(gutter(container, "new", 6), { ms: 50 });
    expect(selected(container)).toHaveLength(4);
    expect(screen.getByText(/Comment on new lines 3-6/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear range" })).toBeInTheDocument();
    // Save works with taps only.
    fireEvent.change(editorBox(), { target: { value: "dictated note" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(getLineComments(THREAD)[0]).toMatchObject({ start: 3, end: 6, note: "dictated note" });
  });

  it("a tap on a row with no number on the range's side says so and keeps the range", async () => {
    vi.useRealTimers();
    const { container } = show();
    await ready(container);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    touchTap(gutter(container, "old", 2), { ms: 50 });
    vi.advanceTimersByTime(700);
    touchTap(gutter(container, "new", 3), { ms: 50 }); // an added row: no old number
    expect(screen.getByText("That row has no line number on this side.")).toBeInTheDocument();
    expect(selected(container)).toHaveLength(1);
  });
});

describe("opened unchanged context", () => {
  const OLD = "abcdefghijkl".split("");
  const NEW = [...OLD];
  NEW[1] = "B";
  NEW[10] = "K";
  const GAPPED = ["diff --git a/src/f.ts b/src/f.ts", "--- a/src/f.ts", "+++ b/src/f.ts", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", "@@ -10,3 +10,3 @@", " j", "-k", "+K", " l", ""].join("\n");

  it("a tap on a line opened from context says why instead of 'no line number on this side'", async () => {
    const { container } = render(
      <DiffCommentsContext value={{ threadId: THREAD, off: null }}>
        <AnnotatableCodeView patch={GAPPED} path="src/f.ts" wrap eager onExpandContext={async () => ({ oldText: OLD.join("\n") + "\n", newText: NEW.join("\n") + "\n" })} />
      </DiffCommentsContext>,
    );
    await ready(container);
    fireEvent.click(gutter(container, "new", 2));
    fireEvent.click(container.querySelector<HTMLElement>("[data-diff-expand]")!);
    await waitFor(() => expect(container.querySelector('[data-new-line="5"]')).not.toBeNull());
    fireEvent.click(gutter(container, "new", 5), { shiftKey: true });
    expect(screen.getByText("Lines opened from unchanged context can't be commented on.")).toBeInTheDocument();
    expect(screen.queryByText("That row has no line number on this side.")).toBeNull();
    expect(selected(container)).toHaveLength(1);
  });
});

describe("when comments are off", () => {
  it("a read-only device has no gutter buttons", async () => {
    const { container } = show("src/f.ts", "Comments are off: this device is read-only.");
    await waitFor(() => expect(container.querySelector("[data-diff-adapter=hand]")).not.toBeNull());
    expect(container.querySelector("[data-diff-gutter]")).toBeNull();
  });

  it("a refused path has no gutter and says why", async () => {
    const { container } = show(".env");
    await waitFor(() => expect(container.querySelector("[data-diff-adapter=hand]")).not.toBeNull());
    expect(container.querySelector("[data-diff-gutter]")).toBeNull();
    expect(container.querySelector("[data-diff-comments-off]")).toHaveTextContent(/refusal list/);
  });

  it("a journal-style absolute path has no gutter either", async () => {
    const { container } = show("/home/me/repo/src/f.ts");
    await waitFor(() => expect(container.querySelector("[data-diff-adapter=hand]")).not.toBeNull());
    expect(container.querySelector("[data-diff-gutter]")).toBeNull();
    expect(container.querySelector("[data-diff-comments-off]")).toHaveTextContent(/not a plain path/);
  });
});

describe("outside the panel", () => {
  it("is a plain diff with no comment controls", async () => {
    const { container } = render(<AnnotatableCodeView patch={PATCH} path="src/f.ts" wrap eager />);
    await waitFor(() => expect(container.querySelector("[data-diff-adapter=hand]")).not.toBeNull());
    expect(container.querySelector("[data-diff-gutter]")).toBeNull();
  });
});

describe("an editor opened from the list", () => {
  it("places itself in a hunk once the patch is at hand, and shows under the range", async () => {
    const { container } = show();
    await ready(container);
    act(() => setOpenEditor(THREAD, { path: "src/f.ts", gesture: { side: "new", anchor: 3, head: 4, hunk: -1 }, note: "from the list", editingId: null, notice: null }));
    expect(editorBox()).toHaveValue("from the list");
    await waitFor(() => expect(getOpenEditor(THREAD)?.gesture.hunk).toBe(0));
  });
});
