import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { useLockRequired } from "@/lib/lock";
import { server } from "@/test/setup";
import { blockingResponse } from "@/test/stream-deps";
import { renderHook } from "@testing-library/react";

import { sendCommand, V2CommandError } from "./commands";
import { fetchThreadHistory } from "./history";
import { useStreamHealth } from "./stores";

const ok = (sequence: number) => Response.json({ ok: true, sequence });
const fixedId = () => "cmd-1";

describe("sendCommand", () => {
  it("posts commandId, type and payload and returns the sequence", async () => {
    let body: unknown;
    server.use(
      http.post("/api/v2/command", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true, sequence: 42 });
      }),
    );
    await expect(sendCommand("thread.rename", { threadId: "t1", title: "New" })).resolves.toEqual({ sequence: 42 });
    expect(body).toMatchObject({ type: "thread.rename", threadId: "t1", title: "New" });
    expect((body as { commandId: string }).commandId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("retries a network failure once with the same commandId", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(ok(7));
    await expect(sendCommand("thread.pin", { threadId: "t1" }, { fetch, newId: fixedId })).resolves.toEqual({ sequence: 7 });
    expect(fetch).toHaveBeenCalledTimes(2);
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { commandId: string });
    expect(bodies[0]?.commandId).toBe("cmd-1");
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("gives up after the one retry", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(sendCommand("thread.pin", { threadId: "t1" }, { fetch, newId: fixedId })).rejects.toThrow(TypeError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry an HTTP refusal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({ ok: false, code: "conflict", error: "commandId reused" }, { status: 409 }),
    );
    const err = await sendCommand("thread.pin", { threadId: "t1" }, { fetch, newId: fixedId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(V2CommandError);
    expect(err).toMatchObject({ status: 409, code: "conflict" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces herdr-too-old as the blocked state and recovers on the next 200", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(blockingResponse()).mockResolvedValueOnce(ok(9));
    await expect(sendCommand("thread.pin", { threadId: "t1" }, { fetch, newId: fixedId })).rejects.toMatchObject({
      status: 503,
      code: "herdr-too-old",
    });
    expect(useStreamHealth.getState().blocked).toMatchObject({ code: "herdr-too-old", have: "0.8.2" });
    await sendCommand("thread.pin", { threadId: "t1" }, { fetch, newId: fixedId });
    expect(useStreamHealth.getState().blocked).toBeNull();
  });

  it("raises the unlock prompt on a lock 401", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("locked", { status: 401, headers: { "x-sightr-lock": "required" } }));
    const { result, rerender } = renderHook(() => useLockRequired());
    expect(result.current).toBe(false);
    await expect(sendCommand("thread.pin", { threadId: "t1" }, { fetch, newId: fixedId })).rejects.toBeInstanceOf(V2CommandError);
    rerender();
    expect(result.current).toBe(true);
  });
});

describe("fetchThreadHistory", () => {
  it("reads a page with the cursor", async () => {
    let url = "";
    server.use(
      http.get("/api/v2/thread/:id/history", ({ request }) => {
        url = request.url;
        return HttpResponse.json({ runs: [], loose: [], nextCursor: null });
      }),
    );
    await expect(fetchThreadHistory("t 1", "abc", 5)).resolves.toEqual({ runs: [], loose: [], nextCursor: null });
    const u = new URL(url);
    expect(u.pathname).toBe("/api/v2/thread/t%201/history");
    expect(u.searchParams.get("before")).toBe("abc");
    expect(u.searchParams.get("limit")).toBe("5");
  });
});
