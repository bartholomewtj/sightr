import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fixtureTranscript } from "@/test/handlers";
import type { TranscriptEntry } from "@/lib/types";

import {
  INLINE_HISTORY_PAGE,
  INLINE_HISTORY_STEP,
  INLINE_IDLE_RETRY_MS,
  mergeNewest,
  useInlineHistory,
} from "./use-inline-history";

function olderTurn(uuid: string): TranscriptEntry {
  return {
    uuid,
    ts: "2026-07-24T06:00:00.000Z",
    role: "user",
    parts: [{ kind: "text", text: `older ${uuid}` }],
  };
}

describe("useInlineHistory", () => {
  const getScrollElement = () => null;

  it("fetches nothing when the pane has no session", async () => {
    let hits = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, () => {
        hits += 1;
        return HttpResponse.json({ paneId: "w1:p1", available: false, reason: "no-session" });
      }),
    );
    const { result } = renderHook(() =>
      useInlineHistory({ paneId: "w1:p1", enabled: false, getScrollElement }),
    );
    await act(async () => {});
    expect(hits).toBe(0);
    expect(result.current.entries).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it("prefetches the newest page so a swipe up has turns to scroll through", async () => {
    let seen = "";
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, ({ request }) => {
        seen = new URL(request.url).searchParams.get("limit") ?? "";
        return HttpResponse.json({
          paneId: "w1:p1",
          available: true,
          entries: fixtureTranscript,
          hasMore: false,
          total: 2,
          fileTruncated: false,
        });
      }),
    );
    const { result } = renderHook(() =>
      useInlineHistory({ paneId: "w1:p1", enabled: true, getScrollElement }),
    );
    await waitFor(() => expect(result.current.entries.map((e) => e.uuid)).toEqual(["t1", "t2"]));
    expect(seen).toBe(String(INLINE_HISTORY_PAGE));
    expect(result.current.hasMore).toBe(false);
    expect(result.current.unavailable).toBeUndefined();
  });

  it("treats a missing log as empty, not an error banner", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, () =>
        HttpResponse.json({ paneId: "w1:p1", available: false, reason: "no-log" }),
      ),
    );
    const { result } = renderHook(() =>
      useInlineHistory({ paneId: "w1:p1", enabled: true, getScrollElement }),
    );
    await waitFor(() => expect(result.current.unavailable).toBe("no-log"));
    expect(result.current.entries).toEqual([]);
  });

  it("degrades to error when the fetch fails", async () => {
    server.use(http.get(/\/api\/pane\/[^/]+\/history/, () => new HttpResponse(null, { status: 500 })));
    const { result } = renderHook(() =>
      useInlineHistory({ paneId: "w1:p1", enabled: true, getScrollElement }),
    );
    await waitFor(() => expect(result.current.unavailable).toBe("error"));
    expect(result.current.entries).toEqual([]);
  });

  it("growUpward pages backward with before= the oldest held turn", async () => {
    const seen: { limit: string | null; before: string | null }[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, ({ request }) => {
        const url = new URL(request.url);
        seen.push({
          limit: url.searchParams.get("limit"),
          before: url.searchParams.get("before"),
        });
        if (url.searchParams.get("before") === "t1") {
          return HttpResponse.json({
            paneId: "w1:p1",
            available: true,
            entries: [olderTurn("t0")],
            hasMore: false,
            total: 3,
            fileTruncated: false,
          });
        }
        return HttpResponse.json({
          paneId: "w1:p1",
          available: true,
          entries: fixtureTranscript,
          hasMore: true,
          total: 3,
          fileTruncated: false,
        });
      }),
    );
    const { result } = renderHook(() =>
      useInlineHistory({ paneId: "w1:p1", enabled: true, getScrollElement }),
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    await act(async () => {
      result.current.growUpward();
    });
    await waitFor(() => expect(result.current.entries.map((e) => e.uuid)).toEqual(["t0", "t1", "t2"]));
    expect(seen[1]).toEqual({ limit: String(INLINE_HISTORY_STEP), before: "t1" });
    expect(result.current.hasMore).toBe(false);
  });

  it("growUpward is a no-op when nothing older exists", async () => {
    let hits = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, () => {
        hits += 1;
        return HttpResponse.json({
          paneId: "w1:p1",
          available: true,
          entries: fixtureTranscript,
          hasMore: false,
          total: 2,
          fileTruncated: false,
        });
      }),
    );
    const { result } = renderHook(() =>
      useInlineHistory({ paneId: "w1:p1", enabled: true, getScrollElement }),
    );
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    await act(async () => {
      result.current.growUpward();
    });
    expect(hits).toBe(1);
  });
});

describe("useInlineHistory refresh", () => {
  const getScrollElement = () => null;

  function page(entries: TranscriptEntry[], hasMore = false) {
    return HttpResponse.json({
      paneId: "w1:p1",
      available: true,
      entries,
      hasMore,
      total: entries.length,
      fileTruncated: false,
    });
  }

  it("refetches the newest page when the agent's status changes and appends the new turns", async () => {
    let hits = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, () => {
        hits += 1;
        return hits === 1
          ? page(fixtureTranscript)
          : page([...fixtureTranscript, olderTurn("t3")]);
      }),
    );
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useInlineHistory({ paneId: "w1:p1", enabled: true, status, getScrollElement }),
      { initialProps: { status: "working" } },
    );
    await waitFor(() => expect(result.current.entries.map((e) => e.uuid)).toEqual(["t1", "t2"]));
    rerender({ status: "idle" });
    await waitFor(() =>
      expect(result.current.entries.map((e) => e.uuid)).toEqual(["t1", "t2", "t3"]),
    );
    expect(hits).toBe(2);
  });

  it("replaces the held turns when the fresh page shares nothing with them (a new session)", async () => {
    let hits = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, () => {
        hits += 1;
        return hits === 1 ? page(fixtureTranscript, true) : page([olderTurn("n1")], false);
      }),
    );
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useInlineHistory({ paneId: "w1:p1", enabled: true, status, getScrollElement }),
      { initialProps: { status: "idle" } },
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    rerender({ status: "working" });
    await waitFor(() => expect(result.current.entries.map((e) => e.uuid)).toEqual(["n1"]));
    expect(result.current.hasMore).toBe(false);
  });

  it("refetches again shortly after going idle so a last turn the first fetch missed still lands", async () => {
    let hits = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, () => {
        hits += 1;
        return hits < 3 ? page(fixtureTranscript) : page([...fixtureTranscript, olderTurn("t3")]);
      }),
    );
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useInlineHistory({ paneId: "w1:p1", enabled: true, status, getScrollElement }),
      { initialProps: { status: "working" } },
    );
    await waitFor(() => expect(result.current.entries.map((e) => e.uuid)).toEqual(["t1", "t2"]));
    rerender({ status: "idle" });
    await waitFor(() => expect(hits).toBe(2));
    await waitFor(() => expect(result.current.entries.map((e) => e.uuid)).toEqual(["t1", "t2", "t3"]), {
      timeout: INLINE_IDLE_RETRY_MS + 1000,
    });
  });

  it("does not refetch when the status is unchanged on rerender", async () => {
    let hits = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+\/history/, () => {
        hits += 1;
        return page(fixtureTranscript);
      }),
    );
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) =>
        useInlineHistory({ paneId: "w1:p1", enabled: true, status, getScrollElement }),
      { initialProps: { status: "idle" } },
    );
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    rerender({ status: "idle" });
    await act(async () => {});
    expect(hits).toBe(1);
  });
});

describe("mergeNewest", () => {
  const t = (uuid: string, text = uuid): TranscriptEntry => ({
    uuid,
    ts: "2026-07-24T06:00:00.000Z",
    role: "assistant",
    parts: [{ kind: "text", text }],
  });

  it("appends the turns after the overlap and takes the fresh copy of overlapping ones", () => {
    const prev = [t("a"), t("b"), t("c", "c-pending")];
    const fresh = [t("b"), t("c", "c-done"), t("d")];
    expect(mergeNewest(prev, fresh).map((e) => e.parts[0])).toEqual([
      { kind: "text", text: "a" },
      { kind: "text", text: "b" },
      { kind: "text", text: "c-done" },
      { kind: "text", text: "d" },
    ]);
  });

  it("returns the fresh page itself when nothing overlaps", () => {
    const fresh = [t("x")];
    expect(mergeNewest([t("a")], fresh)).toBe(fresh);
  });

  it("returns the fresh page when nothing was held", () => {
    const fresh = [t("x")];
    expect(mergeNewest([], fresh)).toBe(fresh);
  });
});
