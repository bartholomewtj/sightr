import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { countUnseenRows, USER_SCROLL_INTENT_MS, useTimelineFollow } from "./useTimelineFollow";

const msg = (id: string): MessagesTimelineRow =>
  ({ kind: "message", id, createdAt: 1, message: { id, role: "user", text: id, streaming: false, createdAt: 1, updatedAt: 1 }, durationStart: 1, showAssistantMeta: false, showAssistantCopyButton: false, assistantCopyStreaming: false }) as MessagesTimelineRow;
const working: MessagesTimelineRow = { kind: "working", id: "working-indicator-row", createdAt: 1 };

describe("countUnseenRows", () => {
  it("counts rows after the last one the reader had, not prepended history or the live tail", () => {
    const seen = new Set(["a", "b"]);
    expect(countUnseenRows([msg("old"), msg("a"), msg("b"), working, msg("c"), msg("d")], seen)).toBe(2);
    expect(countUnseenRows([msg("a"), msg("b")], null)).toBe(0);
  });
});

describe("useTimelineFollow", () => {
  function setup(atEnd: { value: boolean }, opts: { anyScrollLeaves?: boolean } = {}) {
    const scrollToEnd = vi.fn();
    const clock = { now: 10_000 };
    const container = document.createElement("div");
    const scroller = document.createElement("div");
    scroller.className = "messages-timeline-scroll";
    const row = document.createElement("button");
    scroller.append(row);
    container.append(scroller);
    const readEndState = () => ({ contentLength: 2000, scroll: atEnd.value ? 1400 : 0, scrollLength: 600 });
    const hook = renderHook(
      ({ rows, followRequest }: { rows: MessagesTimelineRow[]; followRequest: number }) =>
        useTimelineFollow({ rows, readEndState, scrollToEnd, followRequest, container, now: () => clock.now, ...opts }),
      { initialProps: { rows: [msg("a"), msg("b")], followRequest: 0 } },
    );
    /** The reader leaves the end with the wheel, then the list reports the scroll. */
    const wheelUp = () => {
      act(() => void scroller.dispatchEvent(new Event("wheel", { bubbles: true })));
      atEnd.value = false;
      act(() => hook.result.current.onScroll());
    };
    return { hook, scrollToEnd, clock, scroller, row, wheelUp };
  }

  it("sticks while near the end; the reader's scroll up shows the pill and counts new rows", () => {
    const atEnd = { value: true };
    const { hook, wheelUp } = setup(atEnd);
    act(() => hook.result.current.onScroll());
    expect(hook.result.current.following).toBe(true);
    wheelUp();
    expect(hook.result.current.following).toBe(false);
    hook.rerender({ rows: [msg("a"), msg("b"), msg("c"), working], followRequest: 0 });
    expect(hook.result.current.unseenCount).toBe(1);
  });

  it("content growing under a following reader re-pins instead of leaving (stop, then send)", () => {
    const atEnd = { value: true };
    const { hook, scrollToEnd } = setup(atEnd);
    // A stopped run's output unfolds: the list fires a scroll 273 px from the end, nobody touched it.
    atEnd.value = false;
    act(() => hook.result.current.onScroll());
    expect(hook.result.current.following).toBe(true);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    // The send's rows land: still following, no pill, nothing counted.
    hook.rerender({ rows: [msg("a"), msg("b"), msg("c"), working], followRequest: 1 });
    act(() => hook.result.current.onScroll());
    expect(hook.result.current.following).toBe(true);
    expect(hook.result.current.unseenCount).toBe(0);
  });

  it("a touch counts while the finger is down and through its momentum; a tap on a row does not", () => {
    const atEnd = { value: true };
    const { hook, clock, scroller, row } = setup(atEnd);
    act(() => void row.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    atEnd.value = false;
    act(() => hook.result.current.onScroll());
    expect(hook.result.current.following).toBe(true);

    act(() => void scroller.dispatchEvent(new Event("touchstart", { bubbles: true })));
    clock.now += 5_000; // a long, slow drag
    act(() => hook.result.current.onScroll());
    expect(hook.result.current.following).toBe(false);
  });

  it("intent goes stale: a scroll long after the last wheel is not the reader's", () => {
    const atEnd = { value: true };
    const { hook, clock, scroller, scrollToEnd } = setup(atEnd);
    act(() => void scroller.dispatchEvent(new Event("wheel", { bubbles: true })));
    clock.now += USER_SCROLL_INTENT_MS + 1;
    atEnd.value = false;
    act(() => hook.result.current.onScroll());
    expect(hook.result.current.following).toBe(true);
    expect(scrollToEnd).toHaveBeenCalled();
  });

  it("with find open any scroll may leave (find scrolls to its hit)", () => {
    const atEnd = { value: false };
    const { hook } = setup(atEnd, { anyScrollLeaves: true });
    act(() => hook.result.current.onScroll());
    expect(hook.result.current.following).toBe(false);
  });

  it("re-follows on jump and on this client's own send", () => {
    const atEnd = { value: true };
    const { hook, scrollToEnd, wheelUp } = setup(atEnd);
    wheelUp();
    expect(hook.result.current.following).toBe(false);
    act(() => hook.result.current.jumpToLatest());
    expect(hook.result.current.following).toBe(true);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    wheelUp();
    expect(hook.result.current.following).toBe(false);
    hook.rerender({ rows: [msg("a"), msg("b")], followRequest: 1 });
    expect(hook.result.current.following).toBe(true);
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
  });
});
