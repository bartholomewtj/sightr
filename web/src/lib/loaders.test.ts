import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fixtureAgents, paneTextWithDraft } from "@/test/handlers";

// loaders.ts keeps a module-level "last good" cache, so each test re-imports the module fresh
// (via vi.resetModules) to start from an empty cache and stay independent of run order.
//
// The write-through cache (lib/last-seen.ts) outlives a module reset by design — it lives in
// sessionStorage precisely so a discarded page can read it back. Clearing it here is what makes each
// case a genuinely cold tab; the cases that WANT a warm one prime it themselves.
beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const failSnapshot = () =>
  server.use(http.get("/api/snapshot", () => new HttpResponse(null, { status: 500 })));

const rejectSnapshot = (status: 401 | 403) =>
  server.use(http.get("/api/snapshot", () => new HttpResponse(null, { status })));

const failPane = () =>
  server.use(http.get(/\/api\/pane\/[^/]+$/, () => new HttpResponse(null, { status: 500 })));

const rejectPane = (status: 401 | 403) =>
  server.use(http.get(/\/api\/pane\/[^/]+$/, () => new HttpResponse(null, { status })));

describe("rootLoader", () => {
  it("returns the live snapshot on success", async () => {
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.error).toBe(false);
    expect(data.authError).toBe(false);
    expect(data.bridge).toBe("connected");
    expect(data.agents).toHaveLength(2);
  });

  it("carries dialogPresent: true when dialog presence is noted for an agent", async () => {
    const { noteDialogPresence, resetDialogPresence } = await import("./dialog-presence");
    resetDialogPresence();
    try {
      const target = fixtureAgents[1]!;
      noteDialogPresence(target.paneId, true, {
        status: target.status,
        lastActiveAt: target.lastActiveAt,
      });

      const { rootLoader } = await import("./loaders");
      const data = await rootLoader();
      const agent = data.agents.find((a) => a.paneId === target.paneId);
      expect(agent?.dialogPresent).toBe(true);
    } finally {
      resetDialogPresence();
    }
  });

  it.each([401, 403] as const)("marks a %i response as an auth error", async (status) => {
    rejectSnapshot(status);
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.authError).toBe(true);
  });

  it("keeps the last-good herd (flagged error) when a refresh fails", async () => {
    const { rootLoader } = await import("./loaders");
    await rootLoader(); // prime the cache with a good snapshot

    failSnapshot();
    const stale = await rootLoader();

    expect(stale.error).toBe(true);
    expect(stale.authError).toBe(false);
    expect(stale.bridge).toBe("connected"); // from the cached snapshot
    expect(stale.agents).toHaveLength(2);
    expect(stale.agents[0]!.paneId).toBe(fixtureAgents[0]!.paneId);
    expect(stale.lastSeenAt).toEqual(expect.any(Number));
  });

  it("does not mark a network error as an auth error", async () => {
    const { rootLoader } = await import("./loaders");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network failed"));
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.authError).toBe(false);
  });

  it("returns empty + error when there is no last-good snapshot", async () => {
    failSnapshot();
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.agents).toEqual([]);
    expect(data.bridge).toBeUndefined();
    expect(data.lastSeenAt).toBeUndefined();
  });

  it("treats a cold-start TimeoutError as an error snapshot, NOT a rethrow to the error boundary", async () => {
    // The cold-start-against-a-dead-host case: the first snapshot fetch aborts at its timeout with a
    // DOMException named "TimeoutError" (distinct from the "AbortError" of a superseded revalidation).
    // The loader must fall into the error-snapshot branch so RootLayout + the escalation prompt handle
    // it uniformly — it must NOT bubble to RootError's generic "Something went wrong" screen.
    const { rootLoader } = await import("./loaders");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.authError).toBe(false);
    expect(data.bridge).toBeUndefined();
    expect(data.agents).toEqual([]);
  });

});

describe("paneLoader", () => {
  it("returns pane text on success", async () => {
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "w1:p1" } });
    expect(data.error).toBe(false);
    expect(data.authError).toBe(false);
    expect(data.paneId).toBe("w1:p1");
    expect(data.text).toBe(paneTextWithDraft());
  });

  it.each([401, 403] as const)("marks a %i response as an auth error", async (status) => {
    rejectPane(status);
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "w1:p1" } });
    expect(data.error).toBe(true);
    expect(data.authError).toBe(true);
  });

  it("keeps the last-good pane text (flagged error) when a refresh fails", async () => {
    const { paneLoader } = await import("./loaders");
    await paneLoader({ params: { paneId: "w1:p1" } }); // prime per-pane cache

    failPane();
    const stale = await paneLoader({ params: { paneId: "w1:p1" } });

    expect(stale.error).toBe(true);
    expect(stale.authError).toBe(false);
    expect(stale.text).toBe(paneTextWithDraft());
    expect(stale.paneId).toBe("w1:p1");
  });

  it("returns empty text + error when no last-good exists for that pane", async () => {
    failPane();
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "wX:p9" } });
    expect(data.error).toBe(true);
    expect(data.text).toBe("");
    expect(data.paneId).toBe("wX:p9");
  });

  it("treats a TimeoutError from fetchPane as degraded (stale text + error), NOT a rethrow", async () => {
    // A request that times out aborts with a DOMException named "TimeoutError" — distinct from the
    // "AbortError" of a superseded revalidation. The loader rethrows only AbortError, so a timeout
    // must fall into the stale-data branch (keep the last-good text on screen, flagged) and not
    // bubble up as if the run were superseded.
    const { paneLoader } = await import("./loaders");
    await paneLoader({ params: { paneId: "w1:p1" } }); // prime the per-pane stale cache (via MSW)

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const stale = await paneLoader({ params: { paneId: "w1:p1" } });

    expect(stale.error).toBe(true);
    expect(stale.authError).toBe(false);
    expect(stale.text).toBe(paneTextWithDraft());
    expect(stale.paneId).toBe("w1:p1");
  });

  it("throws on a missing :paneId param (fail-loud to the error boundary)", async () => {
    const { paneLoader } = await import("./loaders");
    await expect(paneLoader({ params: {} })).rejects.toThrow(/paneId/);
  });
});


// A PWA must navigate INSTANTLY to last-known data while offline. During a KNOWN, escalated outage
// (the shared connection-health store has latched "lost"), a NAVIGATION (loader run at a NEW url) skips
// the doomed fetch and returns cache immediately (flagged error); a REVALIDATION (same url — the poll)
// still really fetches, so recovery is discovered and the stale data swapped out. connection-health is
// imported AFTER vi.resetModules() alongside loaders so both share one fresh module instance (the latch
// the test sets is the one the loader reads).
describe("loaders — offline navigation fast path", () => {
  it("a navigation during a known outage returns the cached snapshot INSTANTLY (error, no fetch)", async () => {
    const { rootLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    await rootLoader({ request: new Request("http://localhost/") }); // prime the last-good snapshot
    latchLost(); // escalated outage

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // Different url ⇒ navigation ⇒ fast path: cache returned without touching the network.
    const data = await rootLoader({ request: new Request("http://localhost/space/w1") });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.error).toBe(true); // flagged stale
    expect(data.bridge).toBe("connected"); // last-known herd
    expect(data.agents).toHaveLength(2);
  });

  it("keeps the last auth classification on the navigation fast path", async () => {
    rejectSnapshot(401);
    const { rootLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    const rejected = await rootLoader({ request: new Request("http://localhost/") });
    expect(rejected.authError).toBe(true);
    latchLost();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const data = await rootLoader({ request: new Request("http://localhost/space/w1") });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.error).toBe(true);
    expect(data.authError).toBe(true);
  });

  it("a revalidation (same url) still really fetches while latched — polls keep probing", async () => {
    const { rootLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    await rootLoader({ request: new Request("http://localhost/") }); // sets lastRootUrl = "/"
    latchLost();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await rootLoader({ request: new Request("http://localhost/") }); // same url ⇒ revalidation
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("recovery: the next successful revalidation clears the latch and returns fresh, live data", async () => {
    const { rootLoader } = await import("./loaders");
    const { latchLost, isLostLatched } = await import("./connection-health");

    await rootLoader({ request: new Request("http://localhost/") });
    latchLost();
    expect(isLostLatched()).toBe(true);

    const data = await rootLoader({ request: new Request("http://localhost/") }); // lands (MSW success)
    expect(data.error).toBe(false);
    expect(isLostLatched()).toBe(false); // markLive cleared the latch
  });

  it("navigating to an UNVISITED pane during an outage returns a degraded pane INSTANTLY (no fetch)", async () => {
    const { paneLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");
    latchLost();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const data = await paneLoader({
      params: { paneId: "wX:p9" },
      request: new Request("http://localhost/pane/wX:p9"),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.error).toBe(true);
    expect(data.text).toBe(""); // never fetched → empty mirror, but instant (no 10s hang)
    expect(data.revision).toBe(0);
  });

  it("returning to a PREVIOUSLY-VISITED pane during an outage shows its stale mirror INSTANTLY", async () => {
    const { rootLoader, paneLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    // Visit the pane (healthy) so its text is cached, then leave to the dashboard — rootLoader clears
    // the pane discriminator so a RETURN reads as a fresh navigation, not a poll.
    await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1:p1"),
    });
    await rootLoader({ request: new Request("http://localhost/") });

    latchLost();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const data = await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1:p1"),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(data.error).toBe(true);
    expect(data.text).toBe(paneTextWithDraft()); // the stale mirror
  });

  it("polling within a pane during an outage keeps fetching (same url ⇒ revalidation)", async () => {
    const { paneLoader } = await import("./loaders");
    const { latchLost } = await import("./connection-health");

    await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1:p1"),
    });
    latchLost();

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await paneLoader({
      params: { paneId: "w1:p1" },
      request: new Request("http://localhost/pane/w1:p1"), // same url ⇒ poll ⇒ must fetch
    });
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("does NOT fast-path when the connection is not latched (a brief blip still fetches)", async () => {
    const { rootLoader } = await import("./loaders");
    // No latchLost(): a transient blip must keep really fetching on navigation, not serve stale.
    await rootLoader({ request: new Request("http://localhost/") });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await rootLoader({ request: new Request("http://localhost/space/w1") }); // navigation, but not latched
    expect(fetchSpy).toHaveBeenCalled();
  });
});

// A superseded revalidation aborts the in-flight fetch via request.signal. The loaders must
// RETHROW that AbortError (so React Router discards the stale run) rather than swallow it into the
// stale-data/error-banner branch — otherwise a fast poll would flash a spurious "reconnecting…".
describe("loaders — aborted request", () => {
  function abortedRequest(): Request {
    const controller = new AbortController();
    controller.abort();
    return new Request("http://localhost/", { signal: controller.signal });
  }

  it("rootLoader rethrows the abort instead of returning stale/error data", async () => {
    const { rootLoader } = await import("./loaders");
    await expect(rootLoader({ request: abortedRequest() })).rejects.toThrow();
  });

  it("paneLoader rethrows the abort instead of returning stale/error data", async () => {
    const { paneLoader } = await import("./loaders");
    await expect(
      paneLoader({ params: { paneId: "w1:p1" }, request: abortedRequest() }),
    ).rejects.toThrow();
  });
});

// ── Surviving a cold boot with no network (lib/last-seen.ts) ──────────────────
//
// The case: a phone leaves Sighter for the Tailscale app, the browser DISCARDS the hidden page, and
// the operator comes back before the tunnel is up. The module caches above are gone with the process,
// so everything here re-imports the loaders (a fresh page) and asserts against what a fresh page can
// still read: the write-through cache in sessionStorage.
describe("cold boot with no network", () => {
  const PANE_KEY = "sightr:last-pane:w1:p1";
  const SNAPSHOT_KEY = "sightr:last-snapshot:";

  it("writes the snapshot through on a successful fetch", async () => {
    const { rootLoader } = await import("./loaders");
    await rootLoader();
    expect(sessionStorage.getItem(SNAPSHOT_KEY)).not.toBeNull();
  });

  it("writes the pane mirror through on a successful fetch", async () => {
    const { paneLoader } = await import("./loaders");
    await paneLoader({ params: { paneId: "w1:p1" } });
    expect(sessionStorage.getItem(PANE_KEY)).toContain("hello from the pane");
  });

  it("renders the cached herd — dated — when a fresh page can't reach the bridge", async () => {
    const warm = await import("./loaders");
    await warm.rootLoader(); // the session before the page was discarded

    // A brand-new page: module caches empty, first fetch fails.
    vi.resetModules();
    failSnapshot();
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();

    expect(data.error).toBe(true);
    expect(data.bridge).toBe("connected"); // from the restored snapshot
    expect(data.agents).toHaveLength(2);
    expect(data.lastSeenAt).toBeTypeOf("number");
  });

  it("renders the cached pane mirror — dated — on a fresh page", async () => {
    const warm = await import("./loaders");
    await warm.paneLoader({ params: { paneId: "w1:p1" } });

    vi.resetModules();
    failPane();
    const { paneLoader } = await import("./loaders");
    const data = await paneLoader({ params: { paneId: "w1:p1" } });

    expect(data.error).toBe(true);
    expect(data.text).toContain("hello from the pane");
    expect(data.lastSeenAt).toBeTypeOf("number");
  });

  it("says disconnected, not empty, when a fresh page has nothing cached", async () => {
    failSnapshot();
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();

    // `error` is the flag the empty state keys off: an empty herd here means "we don't know", and
    // components/agent-list.tsx must not read it as "nothing is running".
    expect(data.error).toBe(true);
    expect(data.agents).toEqual([]);
    expect(data.lastSeenAt).toBeUndefined();
  });

  it("survives a store that refuses to answer", async () => {
    const boom = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    failSnapshot();
    const { rootLoader } = await import("./loaders");
    const data = await rootLoader();
    expect(data.error).toBe(true);
    expect(data.agents).toEqual([]);
    boom.mockRestore();
  });

  // ADR 0017: recognising a password prompt changes what Sighter says — and this, the one other thing
  // it changes. The pane the operator is answering `sudo` in is not left in the browser's store.
  describe("a pane at a password prompt (ADR 0017)", () => {
    const sudoPane = () =>
      server.use(
        http.get(/\/api\/pane\/[^/]+$/, () =>
          HttpResponse.json({
            paneId: "w1:p1",
            text: "$ sudo -v\n[sudo] password for altan:",
            truncated: false,
            revision: 2,
          }),
        ),
      );

    it("is never written to the cache", async () => {
      sudoPane();
      const { paneLoader } = await import("./loaders");
      await paneLoader({ params: { paneId: "w1:p1" } });
      expect(sessionStorage.getItem(PANE_KEY)).toBeNull();
    });

    it("drops what an earlier read had already cached", async () => {
      const { paneLoader } = await import("./loaders");
      await paneLoader({ params: { paneId: "w1:p1" } }); // ordinary screen, cached
      expect(sessionStorage.getItem(PANE_KEY)).not.toBeNull();

      sudoPane();
      await paneLoader({ params: { paneId: "w1:p1" } });
      expect(sessionStorage.getItem(PANE_KEY)).toBeNull();
    });

    it("still caches the snapshot — the exclusion is the pane's text, not the herd", async () => {
      sudoPane();
      const { paneLoader, rootLoader } = await import("./loaders");
      await paneLoader({ params: { paneId: "w1:p1" } });
      await rootLoader();
      expect(sessionStorage.getItem(SNAPSHOT_KEY)).not.toBeNull();
    });
  });
});

describe("filesShouldRevalidate", () => {
  it("skips a same-path poll and reloads when the folder changes", async () => {
    const { filesShouldRevalidate } = await import("./loaders");
    const folder = new URL("http://x/files/src");
    const nested = new URL("http://x/files/src/lib");
    expect(filesShouldRevalidate({ currentUrl: folder, nextUrl: folder })).toBe(false);
    expect(filesShouldRevalidate({ currentUrl: folder, nextUrl: nested })).toBe(true);
  });
});
