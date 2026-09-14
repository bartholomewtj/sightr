import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useAgentTransitions, TRANSITION_STATUS_TTL_MS } from "./use-transitions";
import { useStatus, clearStatus } from "@/lib/status";
import type { AgentView } from "@/lib/types";

const agent = (status: AgentView["status"]): AgentView => ({
  paneId: "w:p", workspaceId: "w", workspaceLabel: "space", workspaceNumber: 1,
  tabId: "w:t", agent: "claude", status, cwd: "/tmp", focused: false,
});

describe("useAgentTransitions", () => {
  beforeEach(() => { vi.useFakeTimers(); clearStatus(); });
  afterEach(() => vi.useRealTimers());

  it.each([["blocked", "warn"], ["done", "success"]] as const)("links a %s transition for six seconds", (next, tone) => {
    const { result, rerender } = renderHook(({ value }) => {
      useAgentTransitions([agent(value)], null);
      return useStatus();
    }, { initialProps: { value: "idle" as AgentView["status"] } });
    rerender({ value: next });
    expect(result.current?.tone).toBe(tone);
    expect(result.current?.href).toBe("/pane/w%3Ap");
    act(() => vi.advanceTimersByTime(2500));
    expect(result.current).not.toBeNull();
    act(() => vi.advanceTimersByTime(TRANSITION_STATUS_TTL_MS - 2500));
    expect(result.current).toBeNull();
  });

  it("does not publish on the first snapshot or for the open pane", () => {
    const { result, rerender } = renderHook(({ value, open }) => {
      useAgentTransitions([agent(value)], open);
      return useStatus();
    }, { initialProps: { value: "idle" as AgentView["status"], open: null as string | null } });
    expect(result.current).toBeNull();
    rerender({ value: "blocked", open: "w:p" });
    expect(result.current).toBeNull();
  });
});
