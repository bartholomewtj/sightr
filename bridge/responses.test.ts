import { describe, expect, test } from "bun:test";
import { json, jsonError, text } from "./responses.ts";

// Every API answer is no-store: a JSON 200 gets it from http-cache.ts, and the error helpers set it
// themselves so a 4xx is never served from a cache either (#52).

describe("response helpers", () => {
  test("jsonError is no-store JSON with the security headers", async () => {
    const res = jsonError("unknown session", 404, null);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ error: "unknown session" });
  });

  test("text is no-store with the security headers", async () => {
    const res = text("bad body", 400);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toBe("bad body");
  });

  test("json keeps no-store on a non-200 status", () => {
    expect(json({ ok: false }, null, 409).headers.get("cache-control")).toBe("no-store");
  });
});
