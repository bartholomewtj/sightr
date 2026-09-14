import { beforeEach, describe, expect, it } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { clearLockRequired, useLockRequired } from "./lock";
import { fetchSnapshot, isLockRequiredError } from "./api";

beforeEach(() => clearLockRequired());
describe("lock client state", () => {
  it("identifies lock errors from the response header and ignores plain 403", async () => {
    const hook = renderHook(() => useLockRequired()); act(() => clearLockRequired());
    server.use(http.get("*/api/snapshot", () => new HttpResponse("unlock required", { status: 401, headers: { "x-sightr-lock": "required" } })));
    let lockError: unknown; await act(async () => { lockError = await fetchSnapshot().catch(e => e); }); expect(isLockRequiredError(lockError)).toBe(true); expect(hook.result.current).toBe(true);
    act(() => clearLockRequired()); expect(hook.result.current).toBe(false); server.use(http.get("*/api/snapshot", () => new HttpResponse("forbidden", { status: 403 })));
    let ordinary: unknown; await act(async () => { ordinary = await fetchSnapshot().catch(e => e); }); expect(isLockRequiredError(ordinary)).toBe(false); expect(hook.result.current).toBe(false);
  });
});
