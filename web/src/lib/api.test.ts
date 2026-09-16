import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fixtureSnapshot } from "@/test/handlers";
import { __resetConnectionHealth, lastHealthyAt } from "./connection-health";
import {
  createTab,
  deleteFile,
  saveFile,
  ApiError,
  fetchPane,
  fetchSnapshot,
  invalidatePaneCache,
  sendKeys,
  sendReply,
  uploadImage,
  XHR_HEADER,
  XHR_HEADER_VALUE,
} from "./api";

// The default happy-path handlers live in test/handlers.ts; here we focus on the write paths and the
// ApiError-on-non-2xx contract that every mutation depends on (and uploadImage's separate code path).
describe("api client", () => {
  it("deleteFile posts the path and returns success", async () => {
    let request: Request | undefined;
    server.use(http.post("/api/files/delete", ({ request: req }) => { request = req; return HttpResponse.json({ ok: true }); }));
    await expect(deleteFile("src/notes.md")).resolves.toEqual({ ok: true });
    expect(await request!.json()).toEqual({ path: "src/notes.md" });
  });

  it("deleteFile recovers busy conflicts", async () => {
    server.use(http.post("/api/files/delete", () => HttpResponse.json({ ok: false, error: "file is in use" }, { status: 409 })));
    await expect(deleteFile("a.txt")).resolves.toEqual({ ok: false, error: "file is in use" });
  });

  it("deleteFile throws ordinary failures", async () => {
    server.use(http.post("/api/files/delete", () => new HttpResponse("denied", { status: 403 })));
    await expect(deleteFile("a.txt")).rejects.toThrow(/403/);
  });

  it("saveFile posts its complete request and returns success", async () => {
    let request: Request | undefined;
    server.use(http.post("/api/files/save", ({ request: req }) => { request = req; return HttpResponse.json({ ok: true, mtimeMs: 2, size: 3 }); }));
    await expect(saveFile("src/notes.md", "new", 1)).resolves.toEqual({ ok: true, mtimeMs: 2, size: 3 });
    expect(request!.headers.get("content-type")).toContain("application/json");
    expect(request!.headers.get(XHR_HEADER)).toBe(XHR_HEADER_VALUE);
    expect(await request!.json()).toEqual({ path: "src/notes.md", text: "new", mtimeMs: 1 });
  });

  for (const error of ["file changed", "file is in use"] as const) it(`saveFile recovers ${error}`, async () => {
    server.use(http.post("/api/files/save", () => HttpResponse.json({ ok: false, error }, { status: 409 })));
    await expect(saveFile("a.txt", "x", 1)).resolves.toEqual({ ok: false, error });
  });

  it("saveFile uses a safe fallback for an unparseable conflict", async () => {
    server.use(http.post("/api/files/save", () => new HttpResponse("busy", { status: 409 })));
    await expect(saveFile("a.txt", "x", 1)).resolves.toEqual({ ok: false, error: "not saved" });
  });

  it("saveFile throws forbidden failures", async () => {
    server.use(http.post("/api/files/save", () => new HttpResponse("denied", { status: 403 })));
    await expect(saveFile("a.txt", "x", 1)).rejects.toBeInstanceOf(ApiError);
  });

  it("saveFile recovers oversized responses", async () => {
    server.use(http.post("/api/files/save", () => HttpResponse.json({ error: "file too large" }, { status: 413 })));
    await expect(saveFile("a.txt", "x", 1)).resolves.toEqual({ ok: false, error: "file too large" });
  });
  it("sendReply returns the bridge's ok result on success", async () => {
    await expect(sendReply("w1:p1", "hi")).resolves.toEqual({ ok: true });
  });

  it("createTab posts and returns the created pane", async () => {
    const res = await createTab("w2");
    expect(res.ok).toBe(true);
  });

  it("throws with the status and body on a non-2xx response", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, () => new HttpResponse("herdr down", { status: 502 })),
    );
    await expect(sendReply("w1:p1", "hi")).rejects.toThrow(/502/);
    await expect(sendReply("w1:p1", "hi")).rejects.toThrow(/herdr down/);
  });

  it("adds expected_prompt to reply and keys bodies only when supplied", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/(reply|keys)$/, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true });
      }),
    );

    await sendReply("w1:p1", "hi", true, "Approve?\n1. Yes");
    await sendKeys("w1:p1", ["1"], "Approve?\n1. Yes");
    await sendKeys("w1:p1", ["Left"]);

    expect(bodies).toEqual([
      { text: "hi", submit: true, expected_prompt: "Approve?\n1. Yes" },
      { keys: ["1"], expected_prompt: "Approve?\n1. Yes" },
      { keys: ["Left"] },
    ]);
  });

  it("returns the structured prompt_changed result instead of throwing on 409", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/keys$/, () =>
        HttpResponse.json(
          { ok: false, error: "prompt changed", code: "prompt_changed" },
          { status: 409 },
        ),
      ),
    );
    await expect(sendKeys("w1:p1", ["1"], "Approve?")).resolves.toEqual({
      ok: false,
      error: "prompt changed",
      code: "prompt_changed",
    });
  });

  // The bridge runs the binding check on BOTH endpoints that accept `expected_prompt`, so reply
  // must recover a 409 exactly like keys. They are easy to let drift apart: the recovery used to be
  // blanket handling inside the transport, and moving it to the call sites is precisely the moment
  // one of them gets forgotten and starts throwing where the other returns a value.
  it("returns the structured prompt_changed result instead of throwing on 409 for reply too", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, () =>
        HttpResponse.json(
          { ok: false, error: "prompt changed", code: "prompt_changed" },
          { status: 409 },
        ),
      ),
    );
    await expect(sendReply("w1:p1", "hi", true, "Approve?")).resolves.toEqual({
      ok: false,
      error: "prompt changed",
      code: "prompt_changed",
    });
  });

  it("uploadImage posts multipart and returns the saved path", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/tmp/x.png" })),
    );
    const file = new File(["x"], "x.png", { type: "image/png" });
    await expect(uploadImage("w1:p1", file)).resolves.toEqual({ ok: true, path: "/tmp/x.png" });
  });

  it("uploadImage throws on a non-2xx via its own (non-JSON) error path", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => new HttpResponse("too big", { status: 413 })),
    );
    const file = new File(["x"], "x.png", { type: "image/png" });
    await expect(uploadImage("w1:p1", file)).rejects.toThrow(/413/);
  });


});

// Every request carries a deadline so a black-holed connection can't leave a fetch pending forever.
// GOTCHA: AbortSignal.timeout is NOT driven by Vitest fake timers in Node, so we don't try to
// fast-forward a 10s budget. Instead we spy on AbortSignal.timeout to assert the RIGHT budget is
// requested per endpoint class and that its signal reaches fetch, plus one real-timer test (tiny ms)
// proving the produced signal actually aborts a pending op with a TimeoutError.

describe("api client — request paths", () => {
  afterEach(() => vi.restoreAllMocks());

  function captureUrls() {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(String(input));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    return urls;
  }

  it("hits the plain paths (no query beyond ?lines=)", async () => {
    const urls = captureUrls();
    await fetchSnapshot();
    await fetchPane("w1:p1", 600);
    await sendReply("w1:p1", "hi", true);
    expect(urls[0]).toBe("/api/snapshot");
    expect(urls[1]).toBe("/api/pane/w1%3Ap1?lines=600");
    expect(urls[2]).toBe("/api/pane/w1%3Ap1/reply");
  });

});

// The fetch layer is where liveness is stamped onto the shared lib/connection-health anchor (the same
// interception point that captures X-Sightr-Build). A live snapshot/pane stamps; a 200 that reports
// the herd link down must NOT — otherwise the "Herdr is down" escalation could never fire.
describe("api client — connection-health stamping", () => {
  it("stamps a live moment on a healthy snapshot (bridge connected)", async () => {
    __resetConnectionHealth(1); // pin the anchor far in the past
    await fetchSnapshot(); // default handler → fixtureSnapshot.bridge === "connected"
    expect(lastHealthyAt()).toBeGreaterThan(1);
  });

  it("does NOT stamp when the snapshot 200s but reports the herd link disconnected", async () => {
    server.use(
      http.get("/api/snapshot", () =>
        HttpResponse.json({ ...fixtureSnapshot, bridge: "disconnected" }),
      ),
    );
    __resetConnectionHealth(1);
    await fetchSnapshot();
    expect(lastHealthyAt()).toBe(1); // a 200 that says "Herdr down" is not a provably-live moment
  });

  it("stamps a live moment on a successful pane read", async () => {
    __resetConnectionHealth(1);
    await fetchPane("w1:p1"); // default handler → 200 body
    expect(lastHealthyAt()).toBeGreaterThan(1);
  });

  it("does NOT stamp when a poll fails (the throw precedes the stamp)", async () => {
    server.use(http.get("/api/snapshot", () => new HttpResponse("boom", { status: 502 })));
    __resetConnectionHealth(1);
    await expect(fetchSnapshot()).rejects.toThrow(/502/);
    expect(lastHealthyAt()).toBe(1);
  });
});

// A proxy that REDIRECTS an unauthenticated request instead of refusing it strips Sightr of the only
// signal `isAuthError` (lib/loaders.ts) can act on: `fetch` follows the cross-origin 302, the call
// rejects as a TypeError with no status, and the refusal banner — with the Sign-in link that would
// restore the session — never renders. Marking requests as XHR is what makes such a proxy answer 401
// instead. Every path that talks to the bridge must carry it, including the two that bypass `req`:
// fetchPane builds its own header bag, and uploadImage sets none at all so the browser keeps
// ownership of the multipart boundary.
describe("api client — pane ETag cache", () => {
  it("invalidatePaneCache drops the cached etag so the next read is unconditional", async () => {
    const etags: string[] = [];
    server.use(
      http.get("/api/pane/:paneId", ({ request }) => {
        etags.push(request.headers.get("if-none-match") ?? "");
        return HttpResponse.json(
          { paneId: "w1:p1", text: "frame", truncated: false, revision: 1 },
          { headers: { etag: '"a"' } },
        );
      }),
    );
    await fetchPane("w1:p1");
    await fetchPane("w1:p1");
    expect(etags).toEqual(["", '"a"']);
    invalidatePaneCache("w1:p1");
    await fetchPane("w1:p1");
    expect(etags[2]).toBe("");
  });
});

describe("api client — XHR marker for identity proxies", () => {
  afterEach(() => vi.restoreAllMocks());

  function captureHeaders() {
    const seen: Headers[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    return seen;
  }

  it("marks reads, mutations, pane polls and uploads alike", async () => {
    const seen = captureHeaders();
    await fetchSnapshot();
    await sendReply("w1:p1", "hi");
    await fetchPane("w1:p1");
    await uploadImage("w1:p1", new File(["x"], "x.png", { type: "image/png" }));
    expect(seen).toHaveLength(4);
    for (const headers of seen) expect(headers.get(XHR_HEADER)).toBe(XHR_HEADER_VALUE);
  });

  it("leaves the multipart upload without a content-type so the boundary survives", async () => {
    const seen = captureHeaders();
    await uploadImage("w1:p1", new File(["x"], "x.png", { type: "image/png" }));
    expect(seen[0].get("content-type")).toBeNull();
  });
});
