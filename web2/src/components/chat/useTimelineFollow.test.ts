import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { countUnseenRows, useTimelineFollow } from "./useTimelineFollow";

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
  function setup(atEnd: { value: boolean }) {
    const scrollToEnd = vi.fn();
    const readEndState = () => ({ contentLength: 2000, scroll: atEnd.value ? 1400 : 0, scrollLength: 600 });
    const hook = renderHook(
      ({ rows, followRequest }: { rows: MessagesTimelineRow[]; followRequest: number }) =>
        useTimelineFollow({ rows, readEndState, scrollToEnd, followRequest }),
      { initialProps: { rows: [msg("a"), msg("b")], followRequest: 0 } },
    );
    return { hook, scrollToEnd };
  }

  it("sticks while near the end; a scroll up shows the pill and counts new rows", () => {
    const atEnd = { value: true };
    const { hook } = setup(atEnd);
    act(() => hook.result.current.onScroll());
    expect(hook.result.current.following).toBe(true);
    atEnd.value = false;
    act(() => hook.result.current.onScroll());
    expect(hook.result.current.following).toBe(false);
    hook.rerender({ rows: [msg("a"), msg("b"), msg("c"), working], followRequest: 0 });
    expect(hook.result.current.unseenCount).toBe(1);
  });

  it("re-follows on jump and on this client's own send", () => {
    const atEnd = { value: false };
    const { hook, scrollToEnd } = setup(atEnd);
    act(() => hook.result.current.onScroll());
    expect(hook.result.current.following).toBe(false);
    act(() => hook.result.current.jumpToLatest());
    expect(hook.result.current.following).toBe(true);
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.onScroll());
    hook.rerender({ rows: [msg("a"), msg("b")], followRequest: 1 });
    expect(hook.result.current.following).toBe(true);
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
  });
});
