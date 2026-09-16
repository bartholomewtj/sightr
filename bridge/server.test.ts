import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, normalize } from "node:path";

import { SEEN_HEADER, marksPaneSeen, isLoopbackPeer, isStateChangingMethod, checkAccess, isHostAllowed, guard, deviceAuth, startupWarnings } from "./access.ts";
import { decodePathSegment, failureText, isJsonContentType } from "./responses.ts";
import { BUILD_HEADER, withBuildHeader, resolveStaticPath, isReservedAuthPath, cacheControlFor, isPrivateStaticFile } from "./static-assets.ts";
import {
  paneReadResponse,
  historyParams,
  readPane,
  panePeersAtCwd,
  foldCwd,
  paneReadSpec,
  SHELL_MIRROR_LINES_CAP,
} from "./pane-read-routes.ts";
import type { AgentView } from "./state-engine.ts";
import { sendReplySteps, replyPane, keysPane, type ReplySender } from "./pane-write-routes.ts";
import { normalizeLabel } from "./tree-routes.ts";
import { createPaneQueue } from "./pane-queue.ts";
import type { Config } from "./config.ts";
import type { HerdrClient, PaneRead } from "./herdr-client.ts";
import { FakeHerdrClient as FakePaneClient } from "./test/fake-herdr.ts";
import { RuntimeSettingsStore, resetRuntimeSettings } from "./runtime-settings.ts";

afterEach(() => resetRuntimeSettings());

// checkAccess is the API security gate (same-origin/CSRF + optional Tailscale identity). A
// regression here silently opens remote shell access, so it gets the most direct coverage.

function req(headers: Record<string, string>, method = "GET"): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    method,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  } as unknown as Request;
}

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    socketPath: "/tmp/herdr.sock",
    port: 8787,
    host: "127.0.0.1",
    allowNonLoopbackBind: false,
    pollMs: 1500,
    pollIdleMs: 12_000,
    notifyDelayMs: 30_000,
    readLines: 200,
    transcript: true,
    journalRoots: {
      claude: ["/tmp/claude-projects"],
      pi: ["/nope/pi"],
      grok: ["/nope/grok"],
    },
    submitKeys: ["Enter"],
    commandsFile: "/nope/commands.toml",
    keysFile: "/nope/keys.toml",
    trustedUser: "",
    trustedUserOptional: false,

    deviceHeader: "",
    deviceAllowlist: [],
    allowedOrigins: [],
    publicHosts: [],
    pushAllowedHosts: [],
    tailscaleHosts: [],
    // Test helper default only — keeps non-Host tests testing their own rules without needing ~30
    // call sites updated. The product default is allowAnyHost: false (fail-closed, issue #3).
    allowAnyHost: true,
    vapidPublic: "",
    vapidPrivate: "",
    vapidSubject: "mailto:admin@example.com",
    stateDir: "/tmp/state",
    skipServe: false,
    beacons: false,
    workRoot: "",
    audit: false,
    auditContent: "preview",
    ...overrides,
  };
}

describe("checkAccess — same-origin / CSRF gate", () => {
  test("allows a request with no Origin header (same-origin GET)", () => {
    expect(checkAccess(req({ host: "sightr.example.ts.net" }), cfg())).toEqual({ ok: true });
  });

  test("allows when the Origin host equals the Host header", () => {
    const r = checkAccess(
      req({ origin: "https://sightr.example.ts.net", host: "sightr.example.ts.net" }),
      cfg(),
    );
    expect(r).toEqual({ ok: true });
  });

  test("rejects a genuine cross-origin request", () => {
    const r = checkAccess(
      req({ origin: "https://evil.example.com", host: "sightr.example.ts.net" }),
      cfg(),
    );
    expect(r).toEqual({ ok: false, reason: "cross-origin rejected" });
  });

  test("rejects a loopback Origin that does not match the Host (issue #1)", () => {
    expect(
      checkAccess(req({ origin: "http://localhost:8787", host: "sightr.example.ts.net" }), cfg()),
    ).toEqual({ ok: false, reason: "cross-origin rejected" });
    expect(checkAccess(req({ origin: "http://127.0.0.1:8787", host: "anything" }), cfg())).toEqual({
      ok: false,
      reason: "cross-origin rejected",
    });
    expect(
      checkAccess(req({ origin: "http://[::1]:8787", host: "sightr.example.ts.net" }), cfg(), "write"),
    ).toEqual({ ok: false, reason: "cross-origin rejected" });
  });

  test("a loopback Origin still passes when it matches the Host (curl / host-local browser)", () => {
    expect(
      checkAccess(req({ origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787" }), cfg(), "write"),
    ).toEqual({ ok: true });
  });

  test("a loopback dev origin passes only when SIGHTR_ALLOWED_ORIGINS lists it", () => {
    const c = cfg({ allowedOrigins: ["http://localhost:5173"] });
    expect(
      checkAccess(req({ origin: "http://localhost:5173", host: "localhost:8787" }), c, "write"),
    ).toEqual({ ok: true });
  });

  test("allows an explicitly-configured extra origin (SIGHTR_ALLOWED_ORIGINS)", () => {
    const c = cfg({ allowedOrigins: ["https://sightr.example.com"] });
    const r = checkAccess(
      req({ origin: "https://sightr.example.com", host: "sightr.example.ts.net" }),
      c,
    );
    expect(r).toEqual({ ok: true });
  });

  test("rejects an unparseable Origin", () => {
    expect(checkAccess(req({ origin: "notaurl", host: "h" }), cfg())).toEqual({
      ok: false,
      reason: "bad origin",
    });
  });
});

describe("checkAccess — Tailscale identity gate", () => {
  test("with no trusted user, any identity (or none) passes", () => {
    expect(checkAccess(req({ host: "h" }), cfg())).toEqual({ ok: true });
    expect(
      checkAccess(req({ host: "h", "tailscale-user-login": "anyone@example.com" }), cfg()),
    ).toEqual({ ok: true });
  });

  test("with a trusted user set, a matching login passes", () => {
    const c = cfg({ trustedUser: "me@example.com" });
    expect(
      checkAccess(req({ host: "h", "tailscale-user-login": "me@example.com" }), c),
    ).toEqual({ ok: true });
  });

  test("with a trusted user set, a mismatching login is rejected", () => {
    const c = cfg({ trustedUser: "me@example.com" });
    expect(
      checkAccess(req({ host: "h", "tailscale-user-login": "intruder@example.com" }), c),
    ).toEqual({ ok: false, reason: "identity not trusted" });
  });

  test("with a trusted user set, a MISSING header is rejected (issue #2 — tagged nodes)", () => {
    const c = cfg({ trustedUser: "me@example.com" });
    expect(checkAccess(req({ host: "h" }), c)).toEqual({
      ok: false,
      reason: "identity required",
    });
    // Writes too — and reads, above: a tagged node must not read pane output either.
    expect(checkAccess(req({ host: "h", origin: "http://h" }), c, "write")).toEqual({
      ok: false,
      reason: "identity required",
    });
  });

  test("a loopback Host does not exempt a missing header (Host is the client's to set)", () => {
    const c = cfg({ trustedUser: "me@example.com" });
    expect(checkAccess(req({ host: "127.0.0.1:8787" }), c)).toEqual({
      ok: false,
      reason: "identity required",
    });
  });

  test("under skipServe a missing header still passes (nothing injects one there)", () => {
    const c = cfg({ trustedUser: "me@example.com", skipServe: true });
    expect(checkAccess(req({ host: "h" }), c)).toEqual({ ok: true });
    // …but an ingress that DOES inject a mismatching login is still rejected.
    expect(
      checkAccess(req({ host: "h", "tailscale-user-login": "intruder@example.com" }), c),
    ).toEqual({ ok: false, reason: "identity not trusted" });
  });

  test("SIGHTR_TRUSTED_USER_OPTIONAL restores the old tolerance", () => {
    const c = cfg({ trustedUser: "me@example.com", trustedUserOptional: true });
    expect(checkAccess(req({ host: "h" }), c)).toEqual({ ok: true });
    expect(
      checkAccess(req({ host: "h", "tailscale-user-login": "intruder@example.com" }), c),
    ).toEqual({ ok: false, reason: "identity not trusted" });
  });
});

describe("checkAccess — Host-header validation", () => {
  const c = cfg({ allowAnyHost: false, publicHosts: ["sightr.example.ts.net"] });

  test("the default config rejects a rebound Host==Origin==evil (issue #3)", () => {
    const defaultCfg = cfg({ allowAnyHost: false });
    expect(
      checkAccess(
        req({ origin: "http://evil.example.com", host: "evil.example.com" }),
        defaultCfg,
        "read",
      ),
    ).toEqual({ ok: false, reason: "host not allowed" });
    expect(
      checkAccess(
        req({ origin: "http://evil.example.com", host: "evil.example.com" }),
        defaultCfg,
        "write",
      ),
    ).toEqual({ ok: false, reason: "host not allowed" });
  });

  test("default fail-closed config + loopback Host passes for read and write", () => {
    const defaultCfg = cfg({ allowAnyHost: false });
    expect(checkAccess(req({ host: "127.0.0.1:8787" }), defaultCfg, "read")).toEqual({ ok: true });
    expect(checkAccess(req({ host: "localhost:8787" }), defaultCfg, "write")).toEqual({ ok: true });
  });

  test("DNS-rebinding: Origin==Host==evil host is rejected once publicHosts is set", () => {
    expect(
      checkAccess(req({ origin: "http://evil.example.com", host: "evil.example.com" }), c),
    ).toEqual({ ok: false, reason: "host not allowed" });
    // Fails closed even for a write with a matching evil Origin.
    expect(
      checkAccess(req({ origin: "http://evil.example.com", host: "evil.example.com" }), c, "write"),
    ).toEqual({ ok: false, reason: "host not allowed" });
  });

  test("a legit MagicDNS host with a matching Origin passes", () => {
    expect(
      checkAccess(
        req({ origin: "https://sightr.example.ts.net", host: "sightr.example.ts.net" }),
        c,
      ),
    ).toEqual({ ok: true });
  });

  test("loopback Host always passes even with publicHosts set (read and write)", () => {
    expect(checkAccess(req({ host: "127.0.0.1:8787" }), c)).toEqual({ ok: true });
    expect(checkAccess(req({ host: "localhost:8787" }), c, "write")).toEqual({ ok: true });
  });

  test("a Host derived from an allowed origin passes", () => {
    const c2 = cfg({
      allowAnyHost: false,
      publicHosts: ["sightr.example.ts.net"],
      allowedOrigins: ["https://sightr.example.com"],
    });
    expect(
      checkAccess(req({ origin: "https://sightr.example.com", host: "sightr.example.com" }), c2),
    ).toEqual({ ok: true });
  });

  test("tailscaleHosts allows bare host, port, and IP, but rejects unlisted hosts", () => {
    const cTs = cfg({
      allowAnyHost: false,
      tailscaleHosts: ["sightr.example.ts.net", "100.64.0.1"],
    });
    // Host sightr.example.ts.net (no port) passes — https serve
    expect(
      checkAccess(
        req({ origin: "https://sightr.example.ts.net", host: "sightr.example.ts.net" }),
        cTs,
      ),
    ).toEqual({ ok: true });
    // Host sightr.example.ts.net:8787 passes — http serve mode, same entry
    expect(
      checkAccess(
        req({ origin: "http://sightr.example.ts.net:8787", host: "sightr.example.ts.net:8787" }),
        cTs,
      ),
    ).toEqual({ ok: true });
    // Host 100.64.0.1:8787 passes — raw tailnet IP
    expect(
      checkAccess(
        req({ origin: "http://100.64.0.1:8787", host: "100.64.0.1:8787" }),
        cTs,
      ),
    ).toEqual({ ok: true });
    // Host evil.example.com rejected
    expect(
      checkAccess(
        req({ origin: "http://evil.example.com", host: "evil.example.com" }),
        cTs,
      ),
    ).toEqual({ ok: false, reason: "host not allowed" });
    // Host evil.com:8787 whose bare form is not an entry rejected
    expect(
      checkAccess(
        req({ origin: "http://evil.com:8787", host: "evil.com:8787" }),
        cTs,
      ),
    ).toEqual({ ok: false, reason: "host not allowed" });
  });

  test("allowAnyHost opt-out restores permissive Host validation", () => {
    expect(
      checkAccess(
        req({ origin: "https://evil.example.com", host: "evil.example.com" }),
        cfg({ allowAnyHost: true }),
      ),
    ).toEqual({ ok: true });
  });
});

describe("checkAccess — Origin required for anything state-changing", () => {
  test("write with no Origin from a non-loopback Host is rejected", () => {
    expect(checkAccess(req({ host: "sightr.example.ts.net" }), cfg(), "write")).toEqual({
      ok: false,
      reason: "origin required",
    });
  });

  test("write with no Origin from loopback is allowed (curl on the host)", () => {
    expect(checkAccess(req({ host: "127.0.0.1:8787" }), cfg(), "write")).toEqual({ ok: true });
  });

  test("read with no Origin from a non-loopback Host still passes (the snapshot poll)", () => {
    expect(checkAccess(req({ host: "sightr.example.ts.net" }), cfg(), "read")).toEqual({ ok: true });
  });

  test("write WITH a matching Origin passes (normal browser POST)", () => {
    expect(
      checkAccess(
        req({ origin: "https://sightr.example.ts.net", host: "sightr.example.ts.net" }),
        cfg(),
        "write",
      ),
    ).toEqual({ ok: true });
  });

  // Issue #8: the Origin fallback used to key off the access level alone, so a read-level POST from
  // a remote Host with no Origin at all sailed through — the exact non-browser shape the rule
  // exists to refuse. The method is now part of the question.
  test("a read-level POST with no Origin from a non-loopback Host is rejected (issue #8)", () => {
    expect(checkAccess(req({ host: "sightr.ts.net" }, "POST"), cfg(), "read")).toEqual({
      ok: false,
      reason: "origin required",
    });
  });

  test("a read-level POST with no Origin from loopback is allowed (curl on the host)", () => {
    expect(checkAccess(req({ host: "127.0.0.1:8787" }, "POST"), cfg(), "read")).toEqual({ ok: true });
  });

  test("a read-level POST WITH a matching Origin passes (the settings page)", () => {
    expect(
      checkAccess(
        req({ host: "sightr.ts.net", origin: "https://sightr.ts.net" }, "POST"),
        cfg(),
        "read",
      ),
    ).toEqual({ ok: true });
  });

  test("a GET with no Origin still passes — browsers omit it on same-origin reads", () => {
    expect(checkAccess(req({ host: "sightr.ts.net" }, "GET"), cfg(), "read")).toEqual({ ok: true });
  });
});

describe("isStateChangingMethod", () => {
  test("GET and HEAD are reads; everything else changes state", () => {
    expect(isStateChangingMethod(req({}, "GET"))).toBe(false);
    expect(isStateChangingMethod(req({}, "head"))).toBe(false);
    expect(isStateChangingMethod(req({}, "POST"))).toBe(true);
    expect(isStateChangingMethod(req({}, "delete"))).toBe(true);
  });

  test("a request with no method reads as GET (the header-only test stub)", () => {
    expect(isStateChangingMethod({ headers: { get: () => null } } as unknown as Request)).toBe(false);
  });
});

describe("isHostAllowed", () => {
  test("loopback forms are always allowed", () => {
    const c = cfg({ allowAnyHost: false, publicHosts: ["a.ts.net"] });
    expect(isHostAllowed("127.0.0.1:8787", c)).toBe(true);
    expect(isHostAllowed("localhost", c)).toBe(true);
    expect(isHostAllowed("[::1]:8787", c)).toBe(true);
  });

  test("configured public host and allowed-origin host pass; anything else fails", () => {
    const c = cfg({
      allowAnyHost: false,
      publicHosts: ["a.ts.net"],
      allowedOrigins: ["https://b.example.com"],
    });
    expect(isHostAllowed("a.ts.net", c)).toBe(true);
    expect(isHostAllowed("b.example.com", c)).toBe(true);
    expect(isHostAllowed("evil.com", c)).toBe(false);
    expect(isHostAllowed("", c)).toBe(false);
  });

  test("tailscale hosts match bare or with any port, including IPv6 literals", () => {
    const c = cfg({
      allowAnyHost: false,
      tailscaleHosts: ["sightr.example.ts.net", "[fd7a::1]"],
    });
    expect(isHostAllowed("sightr.example.ts.net", c)).toBe(true);
    expect(isHostAllowed("sightr.example.ts.net:8787", c)).toBe(true);
    expect(isHostAllowed("[fd7a::1]", c)).toBe(true);
    expect(isHostAllowed("[fd7a::1]:8787", c)).toBe(true);
    expect(isHostAllowed("other.ts.net", c)).toBe(false);
    expect(isHostAllowed("evil.com:8787", c)).toBe(false);
  });
});

describe("isJsonContentType — JSON routes force a CORS preflight", () => {
  test("accepts application/json with or without parameters", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("Application/JSON")).toBe(true);
  });

  test("rejects the content types a cross-site POST can send without a preflight", () => {
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType("application/x-www-form-urlencoded")).toBe(false);
    expect(isJsonContentType("multipart/form-data; boundary=x")).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
    expect(isJsonContentType("")).toBe(false);
  });
});

describe("resolveStaticPath — static path traversal guard", () => {
  // Built with join(), not written out with slashes: the guard compares against `webDir + sep`, so a
  // fixture that hardcodes "/" would be rejected out of hand on a platform whose separator differs
  // — testing nothing. `rel` is always forward-slashed, which is the function's own promise.
  const WEB = normalize(join("/srv", "sightr", "web", "dist"));

  test("resolves a normal file under the web dir", () => {
    expect(resolveStaticPath("/assets/app.js", WEB)).toEqual({
      rel: "assets/app.js",
      full: join(WEB, "assets", "app.js"),
    });
  });

  test("maps / to index.html", () => {
    expect(resolveStaticPath("/", WEB)).toEqual({
      rel: "index.html",
      full: join(WEB, "index.html"),
    });
  });

  test("rejects a .. traversal attempt", () => {
    expect(resolveStaticPath("/../../etc/passwd", WEB)).toBeNull();
  });

  test("rejects a sibling dir that merely shares the prefix (web/dist-x)", () => {
    // normalize(join(WEB, "../dist-x/evil.js")) === "/srv/sightr/web/dist-x/evil.js" — a bare
    // startsWith(WEB) would accept it; the `+ sep` boundary is what rejects it.
    expect(resolveStaticPath("/../dist-x/evil.js", WEB)).toBeNull();
  });
});

describe("sendReplySteps — two-step send & partial-failure clarity", () => {
  // A fake client that records calls and can be told to fail either step.
  class FakeClient implements ReplySender {
    readonly calls: string[] = [];
    constructor(private readonly failOn?: "text" | "keys") {}
    sendPaneText(_paneId: string, _text: string): Promise<void> {
      this.calls.push("text");
      return this.failOn === "text" ? Promise.reject(new Error("text rejected")) : Promise.resolve();
    }
    sendPaneKeys(_paneId: string, _keys: string[]): Promise<void> {
      this.calls.push("keys");
      return this.failOn === "keys" ? Promise.reject(new Error("keys rejected")) : Promise.resolve();
    }
  }

  const noSleep = async () => {};

  test("types then submits on the happy path", async () => {
    const client = new FakeClient();
    const out = await sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep);
    expect(out).toEqual({ ok: true, textDelivered: true });
    expect(client.calls).toEqual(["text", "keys"]);
  });

  test("text lands but submit fails → distinguishable error + textDelivered:true (don't resend)", async () => {
    const client = new FakeClient("keys");
    const out = await sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep);
    expect(out).toEqual({
      ok: false,
      textDelivered: true,
      error: "typed into the pane but not submitted — check the pane before resending",
    });
    expect(client.calls).toEqual(["text", "keys"]);
  });

  test("text step fails → nothing delivered, generic failure (safe to resend)", async () => {
    const client = new FakeClient("text");
    const out = await sendReplySteps(client, "p1", "hello", true, ["Enter"], noSleep);
    expect(out).toEqual({ ok: false, textDelivered: false, error: "reply failed" });
    expect(client.calls).toEqual(["text"]); // never reached the keys step
  });

  test("submit-only (empty text) failure is a plain failure, not the partial-delivery message", async () => {
    const client = new FakeClient("keys");
    const out = await sendReplySteps(client, "p1", "", true, ["Enter"], noSleep);
    expect(out).toEqual({ ok: false, textDelivered: false, error: "reply failed" });
    expect(client.calls).toEqual(["keys"]); // no text typed
  });

  test("no-submit reply just types the text", async () => {
    const client = new FakeClient();
    const out = await sendReplySteps(client, "p1", "hello", false, ["Enter"], noSleep);
    expect(out).toEqual({ ok: true, textDelivered: true });
    expect(client.calls).toEqual(["text"]);
  });
});

describe("pane write prompt binding", () => {
  function request(body: unknown): Request {
    return new Request("http://localhost/api/pane/w1%3Ap1/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function textRequest(body: unknown): Request {
    return new Request("http://localhost/api/pane/w1%3Ap1/action", {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(body),
    });
  }

  test("keys without expected_prompt writes without an extra pane read", async () => {
    const client = new FakePaneClient();
    const res = await keysPane(
      client as unknown as HerdrClient,
      cfg(),
      "w1:p1",
      request({ keys: ["1"] }),
      createPaneQueue(),
    )
    expect(res.status).toBe(200);
    expect(client.reads).toEqual([]);
    expect(client.keys).toEqual([["w1:p1", ["1"]]]);
  });

  test("reply without expected_prompt writes without an extra pane read", async () => {
    const client = new FakePaneClient();
    const res = await replyPane(
      client as unknown as HerdrClient,
      cfg(),
      "w1:p1",
      request({ text: "hello", submit: false }),
      createPaneQueue(),
    )
    expect(res.status).toBe(200);
    expect(client.reads).toEqual([]);
    expect(client.texts).toEqual([["w1:p1", "hello"]]);
  });

  test("a text/plain POST to a JSON route is refused before any socket call", async () => {
    const client = new FakePaneClient();
    const res = await replyPane(
      client as unknown as HerdrClient,
      cfg(),
      "w1:p1",
      textRequest({ text: "hello", submit: true }),
      createPaneQueue(),
    )
    expect(res.status).toBe(415);
    expect(client.texts).toEqual([]);
    expect(client.keys).toEqual([]);
  });

  test("keys with a text/plain body is refused too", async () => {
    const client = new FakePaneClient();
    const res = await keysPane(
      client as unknown as HerdrClient,
      cfg(),
      "w1:p1",
      textRequest({ keys: ["Enter"] }),
      createPaneQueue(),
    )
    expect(res.status).toBe(415);
    expect(client.keys).toEqual([]);
  });

  test("matching expected_prompt reads the GET window then sends keys", async () => {
    const client = new FakePaneClient();
    const res = await keysPane(
      client as unknown as HerdrClient,
      cfg({ readLines: 321 }),
      "w1:p1",
      request({ keys: ["1"], expected_prompt: "Approve this command?\n1. Yes\n2. No" }),
      createPaneQueue(),
    )
    expect(res.status).toBe(200);
    expect(client.reads).toEqual([["w1:p1", "recent", 321, "ansi"]]);
    expect(client.keys).toEqual([["w1:p1", ["1"]]]);
  });

  test("binding read depth grows beyond a small configured window to contain the expectation", async () => {
    const client = new FakePaneClient();
    const expected = Array.from({ length: 32 }, (_, index) => `prompt line ${index + 1}`).join("\n");
    client.text = expected;
    const res = await keysPane(
      client as unknown as HerdrClient,
      cfg({ readLines: 20 }),
      "w1:p1",
      request({ keys: ["1"], expected_prompt: expected }),
      createPaneQueue(),
    )

    expect(res.status).toBe(200);
    expect(client.reads).toHaveLength(1);
    expect(client.reads[0]?.[0]).toBe("w1:p1");
    expect(client.reads[0]?.[1]).toBe("recent");
    expect(client.reads[0]?.[2]).toBeGreaterThan(32);
    expect(client.reads[0]?.[3]).toBe("ansi");
    expect(client.keys).toEqual([["w1:p1", ["1"]]]);
  });

  test("matching expected_prompt reads the GET window then sends reply text", async () => {
    const client = new FakePaneClient();
    const res = await replyPane(
      client as unknown as HerdrClient,
      cfg({ readLines: 321 }),
      "w1:p1",
      request({
        text: "hello",
        submit: false,
        expected_prompt: "Approve this command?\n1. Yes\n2. No",
      }),
      createPaneQueue(),
    )
    expect(res.status).toBe(200);
    expect(client.reads).toEqual([["w1:p1", "recent", 321, "ansi"]]);
    expect(client.texts).toEqual([["w1:p1", "hello"]]);
  });

  test("stale expected_prompt returns prompt_changed and sends no keys", async () => {
    const client = new FakePaneClient();
    client.text = "Command finished";
    const res = await keysPane(
      client as unknown as HerdrClient,
      cfg(),
      "w1:p1",
      request({ keys: ["1"], expected_prompt: "Approve this command?\n1. Yes\n2. No" }),
      createPaneQueue(),
    )
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      ok: false,
      error: "prompt changed",
      code: "prompt_changed",
    });
    expect(client.keys).toEqual([]);
    expect(client.texts).toEqual([]);
  });

  test("stale expected_prompt returns prompt_changed and sends no reply text or keys", async () => {
    const client = new FakePaneClient();
    client.text = "Command finished";
    const res = await replyPane(
      client as unknown as HerdrClient,
      cfg(),
      "w1:p1",
      request({
        text: "hello",
        submit: true,
        expected_prompt: "Approve this command?\n1. Yes\n2. No",
      }),
      createPaneQueue(),
    )
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "prompt_changed" });
    expect(client.keys).toEqual([]);
    expect(client.texts).toEqual([]);
  });

  test("rejects oversized and non-string expected_prompt before a keys write", async () => {
    for (const expected_prompt of ["x".repeat(8193), 42]) {
      const client = new FakePaneClient();
      const res = await keysPane(
        client as unknown as HerdrClient,
        cfg(),
        "w1:p1",
        request({ keys: ["1"], expected_prompt }),
        createPaneQueue(),
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("bad expected_prompt");
      expect(client.reads).toEqual([]);
      expect(client.keys).toEqual([]);
    }
  });

  test("rejects oversized and non-string expected_prompt before a reply write", async () => {
    for (const expected_prompt of ["x".repeat(8193), null]) {
      const client = new FakePaneClient();
      const res = await replyPane(
        client as unknown as HerdrClient,
        cfg(),
        "w1:p1",
        request({ text: "hello", expected_prompt }),
        createPaneQueue(),
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("bad expected_prompt");
      expect(client.reads).toEqual([]);
      expect(client.texts).toEqual([]);
      expect(client.keys).toEqual([]);
    }
  });

  test("request submit keys take precedence and normalize", async () => {
    const client = new FakePaneClient();
    const res = await replyPane(client as unknown as HerdrClient, cfg(), "w1:p1",
      request({ text: "hi", submit_keys: ["enter", "  ctrl+C  "] }), createPaneQueue());
    expect(res.status).toBe(200);
    expect(client.keys).toEqual([["w1:p1", ["Enter", "ctrl+C"]]]);
    const noSubmit = await replyPane(client as unknown as HerdrClient, cfg(), "w1:p1",
      request({ text: "draft", submit: false }), createPaneQueue());
    expect(noSubmit.status).toBe(200);
  });

  test("uses configured submit keys when request keys are absent and rejects bad lists before writing", async () => {
    const client = new FakePaneClient();
    const ok = await replyPane(client as unknown as HerdrClient, cfg({ submitKeys: ["ctrl+j"] }), "w1:p1",
      request({ text: "hi" }), createPaneQueue());
    expect(ok.status).toBe(200);
    expect(client.keys).toEqual([["w1:p1", ["ctrl+j"]]]);
    for (const submit_keys of ["Enter", [], ["PageUp"], ["C-c"], [1],
      ["Enter", "Enter", "Enter", "Enter", "Enter"], ["a".repeat(33)], [""]]) {
      const fresh = new FakePaneClient();
      const result = await replyPane(fresh as unknown as HerdrClient, cfg(), "w1:p1",
        request({ text: "hi", submit_keys }), createPaneQueue());
      expect(result.status).toBe(400);
      expect(await result.text()).toBe("bad submit_keys");
      expect(fresh.texts).toEqual([]);
      expect(fresh.keys).toEqual([]);
    }
  });
});

describe("paneReadSpec", () => {
  test("shell panes read the visible viewport only", () => {
    expect(
      paneReadSpec({ paneId: "w:p1", kind: "shell" } as import("./state-engine.ts").AgentView, 600),
    ).toEqual({ source: "visible", lines: SHELL_MIRROR_LINES_CAP });
  });

  test("agent panes keep recent scrollback reads", () => {
    expect(
      paneReadSpec({ paneId: "w:p1", kind: "agent" } as import("./state-engine.ts").AgentView, 600),
    ).toEqual({ source: "recent", lines: 600 });
  });
});

describe("paneReadResponse — pane read → REST body", () => {
  test("passes text, truncated, and the monotonic revision through", () => {
    const read: PaneRead = { pane_id: "w1:p1", text: "hello", truncated: true, revision: 42 };
    expect(paneReadResponse("w1:p1", read)).toEqual({
      paneId: "w1:p1",
      text: "hello",
      truncated: true,
      revision: 42,
    });
  });

  test("carries a zero revision unchanged (fresh pane) rather than dropping the field", () => {
    const read: PaneRead = { pane_id: "w2:p1", text: "", truncated: false, revision: 0 };
    expect(paneReadResponse("w2:p1", read)).toEqual({
      paneId: "w2:p1",
      text: "",
      truncated: false,
      revision: 0,
    });
  });
});

describe("historyParams — transcript paging params", () => {
  const params = (qs: string) => historyParams(new URL(`http://x/api/pane/w1:p1/history${qs}`));

  test("no params means the newest page at the default size", () => {
    expect(params("")).toEqual({ limit: 200 });
  });

  test("an explicit limit is honoured", () => {
    expect(params("?limit=10")).toEqual({ limit: 10 });
  });

  // "Show entire history" asks for the whole conversation, so the ceiling is a safety net against a
  // pathological log rather than a paging window.
  test("an absurd limit is clamped to the safety ceiling", () => {
    expect(params("?limit=99999")).toEqual({ limit: 5000 });
  });

  test.each([["zero", "?limit=0"], ["negative", "?limit=-5"], ["garbage", "?limit=abc"]])(
    "a %s limit falls back to the default",
    (_label, qs) => {
      expect(params(qs).limit).toBe(200);
    },
  );

  test("a cursor is carried through as an opaque string", () => {
    expect(params("?before=abc-123")).toEqual({ limit: 200, before: "abc-123" });
  });

  test("an absurdly long cursor is dropped rather than carried", () => {
    expect(params(`?before=${"x".repeat(500)}`)).toEqual({ limit: 200 });
  });

  test("an empty cursor is omitted, not passed as an empty match", () => {
    expect(params("?before=")).toEqual({ limit: 200 });
  });
});

describe("cwdSharedBySibling — grok panes that share a session directory", () => {
  const pane = (paneId: string, cwd: string, agent = "grok"): AgentView => ({
    paneId,
    workspaceId: "w1",
    workspaceLabel: "Grok",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent,
    status: "idle",
    cwd,
    focused: false,
  });

  test("folds separators and case so split panes count as sharing a cwd", () => {
    expect(foldCwd("C:\\work-dir\\")).toBe("c:/work-dir");
    expect(foldCwd("c:/Work-Dir")).toBe("c:/work-dir");
    const a = pane("w1:p1", "C:\\work-dir");
    const b = pane("w1:p2", "C:/Work-Dir/");
    expect(panePeersAtCwd([a, b], [], a)).toEqual(["w1:p1", "w1:p2"]);
    expect(panePeersAtCwd([a], [], a)).toEqual(["w1:p1"]);
  });

  test("a different agent at the same cwd is not a peer", () => {
    const grok = pane("w1:p1", "C:\\work-dir");
    const claude = pane("w1:p2", "C:\\work-dir", "claude");
    expect(panePeersAtCwd([grok, claude], [], grok)).toEqual(["w1:p1"]);
  });
});

describe("deviceAuth — per-device authorisation", () => {
  const HDR = "x-device-id";

  test("feature off: not enforced, fully authorised regardless of any header", () => {
    expect(deviceAuth(req({ host: "h" }), cfg())).toEqual({
      enforced: false,
      device: null,
      authorized: true,
    });
    // A stray header value is ignored entirely when the feature is off.
    expect(deviceAuth(req({ host: "h", "x-device-id": "phone" }), cfg())).toEqual({
      enforced: false,
      device: null,
      authorized: true,
    });
  });

  test("feature on, header absent: refused", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
    expect(deviceAuth(req({ host: "h" }), c)).toEqual({
      enforced: true,
      device: null,
      authorized: false,
    });
    // A blank/whitespace header value is treated as absent, not as a device named "".
    expect(deviceAuth(req({ host: "h", "x-device-id": "  " }), c)).toEqual({
      enforced: true,
      device: null,
      authorized: false,
    });
  });

  // The absent-header case has no loopback exemption, and a loopback-looking Host must not create
  // one by the back door: Host is set by the caller and rewritten by the proxy, so it attests
  // nothing. This pins that no future "but it came from localhost" shortcut sneaks in here.
  test("feature on, header absent: a loopback Host does not buy an exemption", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
    for (const host of ["127.0.0.1", "127.0.0.1:8787", "localhost", "[::1]:8787"]) {
      expect(deviceAuth(req({ host }), c).authorized).toBe(false);
    }
  });
});

// deviceAuth being right in isolation proves nothing if the wiring in guard() regresses, and that
// wiring is where the whole gate lives: it consults deviceAuth for "write" and deliberately not for
// "read". Both halves are asserted here, so neither the gate nor the read-only scope can drift
// silently. The write cases carry a matching Origin so checkAccess passes and the device decision is
// the only thing under test.
describe("guard applies the device gate to writes only", () => {
  const HDR = "x-device-id";
  const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
  const write = (headers: Record<string, string>) =>
    guard(req({ host: "sightr.ts.net", origin: "https://sightr.ts.net", ...headers }), c, "write");
  const read = (headers: Record<string, string>) =>
    guard(req({ host: "sightr.ts.net", ...headers }), c, "read");

  test("write with no device header is refused with 403", () => {
    const denied = write({});
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
  });

  test("write with a non-allowlisted device is refused with 403", () => {
    const denied = write({ "x-device-id": "intruder" });
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(403);
  });

  test("write with an allowlisted device proceeds", () => {
    expect(write({ "x-device-id": "phone" })).toBeNull();
  });

  // The scope of the gate, stated as a test rather than only in prose: a header-less caller keeps
  // READ access (it is read-only, not rejected outright). If someone later tightens this, it should
  // be a deliberate change with this test updated, not an accident.
  // Tightened deliberately in issue #8: notification prefs (POST) and push subscribe are
  // now guarded as "write", so a read-only device can watch and read its prefs but can no longer
  // silence the herd for everyone. Pane reads, history and the snapshot are unchanged.
  test("read with no device header still proceeds (read-only, not rejected)", () => {
    expect(read({})).toBeNull();
    expect(read({ "x-device-id": "intruder" })).toBeNull();
  });

  test("with the feature off, a write with no device header proceeds", () => {
    expect(guard(req({ host: "127.0.0.1:8787" }), cfg(), "write")).toBeNull();
  });

  test("feature on, allowlisted device: authorised and attributed (header is trimmed)", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone", "laptop"] });
    expect(deviceAuth(req({ host: "h", "x-device-id": " phone " }), c)).toEqual({
      enforced: true,
      device: "phone",
      authorized: true,
    });
  });

  test("feature on, non-allowlisted device: read-only (attributed but not authorised)", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["phone"] });
    expect(deviceAuth(req({ host: "h", "x-device-id": "intruder" }), c)).toEqual({
      enforced: true,
      device: "intruder",
      authorized: false,
    });
  });

  test("the 'unknown' sentinel is never authorised, even if it appears in the allowlist", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: ["unknown"] });
    expect(deviceAuth(req({ host: "h", "x-device-id": "unknown" }), c)).toEqual({
      enforced: true,
      device: "unknown",
      authorized: false,
    });
  });

  test("feature on with an empty allowlist: every header-carrying device is read-only (fail-closed)", () => {
    const c = cfg({ deviceHeader: HDR, deviceAllowlist: [] });
    expect(deviceAuth(req({ host: "h", "x-device-id": "phone" }), c)).toEqual({
      enforced: true,
      device: "phone",
      authorized: false,
    });
  });
});

describe("startupWarnings — security-posture nags", () => {
  const has = (ws: string[], needle: string) => ws.some((w) => w.includes(needle));

  test("skipServe + trustedUser: warns the identity gate is inert and points at the device header", () => {
    const ws = startupWarnings(cfg({ skipServe: true, trustedUser: "me@example.com" }));
    expect(has(ws, "SIGHTR_TRUSTED_USER has no effect")).toBe(true);
    expect(has(ws, "SIGHTR_DEVICE_HEADER")).toBe(true);
    // The pointer must name the README section the setting is documented in.
    expect(has(ws, "README.md → Configuration")).toBe(true);
    // The Variant-A empty-trustedUser nag must NOT also fire (it's meaningless behind a proxy).
    expect(has(ws, "any tailnet device/user")).toBe(false);
  });

  test("skipServe + empty trustedUser: no empty-trustedUser warning at all", () => {
    const ws = startupWarnings(cfg({ skipServe: true, trustedUser: "" }));
    expect(has(ws, "SIGHTR_TRUSTED_USER")).toBe(false);
  });

  test("no skipServe + empty trustedUser: the existing Variant-A warning still fires", () => {
    const ws = startupWarnings(cfg({ skipServe: false, trustedUser: "" }));
    expect(has(ws, "SIGHTR_TRUSTED_USER is empty")).toBe(true);
    expect(has(ws, "README.md → Security")).toBe(true);
  });

  test("no skipServe + trustedUser set: no identity warning (correctly configured)", () => {
    const ws = startupWarnings(cfg({ skipServe: false, trustedUser: "me@example.com" }));
    expect(has(ws, "SIGHTR_TRUSTED_USER")).toBe(false);
  });

  test("trustedUserOptional: warns the identity gate accepts an absent header", () => {
    const ws = startupWarnings(cfg({ trustedUser: "me@example.com", trustedUserOptional: true }));
    expect(has(ws, "SIGHTR_TRUSTED_USER_OPTIONAL")).toBe(true);
  });

  test("allowAnyHost: warns that Host validation is OFF", () => {
    const ws = startupWarnings(cfg({ allowAnyHost: true }));
    expect(has(ws, "SIGHTR_ALLOW_ANY_HOST=1")).toBe(true);
  });

  test("empty allowlists: warns that no non-loopback Host is allowed", () => {
    const ws = startupWarnings(
      cfg({ allowAnyHost: false, publicHosts: [], tailscaleHosts: [], allowedOrigins: [] }),
    );
    expect(has(ws, "no non-loopback Host is allowed")).toBe(true);
  });

  test("populated tailscaleHosts: no Host-validation warning", () => {
    const ws = startupWarnings(
      cfg({ allowAnyHost: false, tailscaleHosts: ["sightr.example.ts.net"], publicHosts: [] }),
    );
    expect(has(ws, "Host")).toBe(false);
  });

  test("populated publicHosts: no Host-validation warning", () => {
    const ws = startupWarnings(
      cfg({ allowAnyHost: false, publicHosts: ["sightr.example.ts.net"] }),
    );
    expect(has(ws, "Host")).toBe(false);
  });

  test("loopback IPv6 host ::1 produces no bind warning", () => {
    const ws = startupWarnings(cfg({ host: "::1" }));
    expect(has(ws, "SIGHTR_ALLOW_NON_LOOPBACK_BIND")).toBe(false);
    expect(has(ws, "bound to")).toBe(false);
  });

  test("non-loopback host with override produces a bind warning naming SIGHTR_ALLOW_NON_LOOPBACK_BIND", () => {
    const ws = startupWarnings(cfg({ host: "0.0.0.0", allowNonLoopbackBind: true }));
    expect(has(ws, "SIGHTR_ALLOW_NON_LOOPBACK_BIND")).toBe(true);
    expect(has(ws, "bound to 0.0.0.0")).toBe(true);
  });

  test("pushAllowedHosts with private/loopback entry produces a warning naming the offending host", () => {
    const ws = startupWarnings(cfg({ pushAllowedHosts: ["10.0.0.5", "box.local"] }));
    expect(has(ws, "SIGHTR_PUSH_ALLOWED_HOSTS contains private/loopback host(s) (10.0.0.5, box.local)")).toBe(true);
    expect(has(ws, "issue #7")).toBe(true);
  });

  test("pushAllowedHosts with normal push hosts produces no warning", () => {
    const ws = startupWarnings(cfg({ pushAllowedHosts: ["push.custom.org", "fcm.googleapis.com"] }));
    expect(has(ws, "SIGHTR_PUSH_ALLOWED_HOSTS")).toBe(false);
  });
});

describe("isLoopbackPeer", () => {
  test("accepts loopback addresses across IPv4 and IPv6 representations", () => {
    expect(isLoopbackPeer("127.0.0.1")).toBe(true);
    expect(isLoopbackPeer("127.5.5.5")).toBe(true);
    expect(isLoopbackPeer("::1")).toBe(true);
    expect(isLoopbackPeer("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackPeer("0:0:0:0:0:0:0:1")).toBe(true);
    // Deliberately abstains on null/undefined/empty rather than failing closed (defence in depth).
    expect(isLoopbackPeer(null)).toBe(true);
    expect(isLoopbackPeer(undefined)).toBe(true);
    expect(isLoopbackPeer("")).toBe(true);
  });

  test("rejects non-loopback addresses", () => {
    expect(isLoopbackPeer("192.168.1.10")).toBe(false);
    expect(isLoopbackPeer("100.64.0.1")).toBe(false); // tailnet address — realistic attacker
    expect(isLoopbackPeer("::ffff:192.168.1.10")).toBe(false);
    expect(isLoopbackPeer("10.0.0.1")).toBe(false);
  });
});

// A tab or space label is a non-null, non-empty string (herdr rejects null and stores "" literally — no
// "clear" for a tab or workspace, unlike a pane). normalizeLabel is the gate that enforces that before the RPC.
describe("normalizeLabel", () => {
  test("accepts a non-empty string, trimming surrounding whitespace", () => {
    expect(normalizeLabel("deploy")).toEqual({ ok: true, label: "deploy" });
    expect(normalizeLabel("  deploy  ")).toEqual({ ok: true, label: "deploy" });
    // Same rule for both tab and workspace renames
    expect(normalizeLabel("  my space  ")).toEqual({ ok: true, label: "my space" });
  });

  test("rejects a blank label (empty or whitespace-only) — a tab or space has no clear", () => {
    expect(normalizeLabel("")).toEqual({ ok: false, error: "label required" });
    expect(normalizeLabel("   ")).toEqual({ ok: false, error: "label required" });
  });

  test("rejects a non-string label (null / number / missing)", () => {
    expect(normalizeLabel(null)).toEqual({ ok: false, error: "bad label" });
    expect(normalizeLabel(42)).toEqual({ ok: false, error: "bad label" });
    expect(normalizeLabel(undefined)).toEqual({ ok: false, error: "bad label" });
  });
});

// The X-Sightr-Build response header is what a no-service-worker client polls to notice a live
// rebuild (web/src/lib/server-build.ts). withBuildHeader is the pure attach helper; the handlers
// that call it (snapshot/pane) stay untested by convention (they need Bun.serve + the socket).
describe("withBuildHeader", () => {
  test("sets the build header to the given id and returns the same response", () => {
    const res = new Response("body");
    const out = withBuildHeader(res, "0.13.0+abc.123");
    expect(out).toBe(res);
    expect(out.headers.get(BUILD_HEADER)).toBe("0.13.0+abc.123");
    expect(BUILD_HEADER).toBe("x-sightr-build");
  });

  test("overwrites any existing build header (last write wins)", () => {
    const res = new Response(null, { headers: { [BUILD_HEADER]: "old" } });
    withBuildHeader(res, "new");
    expect(res.headers.get(BUILD_HEADER)).toBe("new");
  });

  test("preserves a 304's empty body and status", async () => {
    const res = withBuildHeader(new Response(null, { status: 304 }), "id-1");
    expect(res.status).toBe(304);
    expect(res.headers.get(BUILD_HEADER)).toBe("id-1");
    expect(await res.text()).toBe("");
  });
});

// Cache-Control selection for served dist files. Hashed assets cache hard; every other (mutable)
// dist file — crucially sw.js, which shipped with NO Cache-Control before — must be no-cache so a
// browser or reverse proxy always revalidates it and can't wedge the update pipeline on a stale copy.
describe("cacheControlFor", () => {
  test("hashed assets under assets/ are immutable", () => {
    expect(cacheControlFor("assets/index-B7cWgJ3M.js")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(cacheControlFor("assets/index-abc.css")).toBe("public, max-age=31536000, immutable");
  });

  test("sw.js and every other mutable dist-root file are no-cache", () => {
    for (const rel of [
      "sw.js",
      "index.html",
      "manifest.webmanifest",
      "favicon.svg",
      "favicon.ico",
      "apple-touch-icon.png",
    ]) {
      expect(cacheControlFor(rel)).toBe("no-cache");
    }
  });
});

// The other end of web/src/lib/sw-routes.ts. The service worker hands `/auth/` to the network; if
// the bridge doesn't recognise the same set, the SPA fallback answers with the app shell and the
// operator gets the very UI they were trying to escape. These two must agree exactly.
describe("isReservedAuthPath — the namespace a fronting proxy owns", () => {
  test("claims /auth with or without a trailing slash, and everything beneath it", () => {
    expect(isReservedAuthPath("/auth")).toBe(true);
    expect(isReservedAuthPath("/auth/")).toBe(true);
    expect(isReservedAuthPath("/auth/sign-in")).toBe(true);
    expect(isReservedAuthPath("/auth/oidc/callback")).toBe(true);
  });

  test("leaves Sightr's own routes alone, including a mere prefix match", () => {
    for (const path of ["/", "/settings", "/pane/w1:p1", "/authors", "/api/snapshot"]) {
      expect(isReservedAuthPath(path)).toBe(false);
    }
  });
});

// marksPaneSeen guards the one place a READ mutates server state. checkAccess lets a read through
// without an Origin (browsers omit it on same-origin GETs), so without this a cross-site <img> at a
// guessed pane id could silently clear the "Ready · unseen" section.
describe("marksPaneSeen — CSRF guard on marking a pane seen", () => {
  const withHeader = (h: Record<string, string> = {}) => new Request("http://x/api/pane/w1:p1", { headers: h });

  test("a read carrying the client header counts — only our own page can set it", () => {
    expect(marksPaneSeen(withHeader({ [SEEN_HEADER]: "1" }), undefined)).toBe(true);
  });

  test("a bare cross-site GET does NOT count", () => {
    // What an <img src="…/api/pane/w1:p1"> produces: no Origin, no custom header.
    expect(marksPaneSeen(withHeader(), undefined)).toBe(false);
  });

  test("history is a read — it needs the header too", () => {
    expect(marksPaneSeen(withHeader(), "history")).toBe(false);
    expect(marksPaneSeen(withHeader({ [SEEN_HEADER]: "1" }), "history")).toBe(true);
  });

  test("write actions count without it — they already cleared the Origin-requiring write gate", () => {
    for (const action of ["reply", "keys", "upload", "close", "rename"]) {
      expect(marksPaneSeen(withHeader(), action)).toBe(true);
    }
  });

  test("any header value counts — presence is the proof, not the contents", () => {
    expect(marksPaneSeen(withHeader({ [SEEN_HEADER]: "" }), undefined)).toBe(true);
    expect(marksPaneSeen(withHeader({ [SEEN_HEADER]: "anything" }), undefined)).toBe(true);
  });
});

// issue #11: three checks key off `rel` (the private-file denial, sw.js's Service-Worker-Allowed
// header, and cacheControlFor's immutable/no-cache split), but `rel` used to come straight from the
// request while only `full` was normalised — so "/./build-info.json" cleared the containment check
// and then dodged a rel-keyed denial. WEB is built with join() so this runs on Windows too; the
// older describe above hardcodes a POSIX path and is a known Windows-only failure.
describe("resolveStaticPath — rel is normalised, not echoed", () => {
  const WEB = normalize(join("/srv", "sightr", "web", "dist"));

  test.each([
    ["/./build-info.json", "build-info.json"],
    ["/a/../build-info.json", "build-info.json"],
    ["/./assets/app.js", "assets/app.js"],
    ["/assets/app.js", "assets/app.js"],
    ["/", "index.html"],
    ["//sw.js", "sw.js"],
  ])("%s → rel %s", (pathname, rel) => {
    expect(resolveStaticPath(pathname, WEB)?.rel).toBe(rel);
  });
});

// The build id in a file, served to anyone who could reach the port. Nothing fetches this path —
// the bridge and sightr-ctl read it off disk — so refusing it costs nothing (issue #11).
describe("isPrivateStaticFile", () => {
  test("build-info.json is never served", () => {
    expect(isPrivateStaticFile("build-info.json")).toBe(true);
  });

  test("every other dist file still is", () => {
    for (const rel of ["index.html", "sw.js", "manifest.webmanifest", "assets/app.js"]) {
      expect(isPrivateStaticFile(rel)).toBe(false);
    }
  });
});

describe("decodePathSegment", () => {
  test("valid plain segment round-trips", () => {
    expect(decodePathSegment("pane-123")).toBe("pane-123");
    expect(decodePathSegment("tab1")).toBe("tab1");
  });

  test("decodes valid percent-escapes", () => {
    expect(decodePathSegment("%20")).toBe(" ");
    expect(decodePathSegment("w1%3Ap1")).toBe("w1:p1");
    expect(decodePathSegment("hello%2Fworld")).toBe("hello/world");
  });

  test("returns null on malformed percent-escapes", () => {
    expect(decodePathSegment("%ff")).toBeNull();
    expect(decodePathSegment("%E0%A4%A")).toBeNull();
    expect(decodePathSegment("%")).toBeNull();
    expect(decodePathSegment("%1")).toBeNull();
    expect(decodePathSegment("%ZZ")).toBeNull();
  });

  test("returns empty string when decoding an empty string (falsy but valid)", () => {
    expect(decodePathSegment("")).toBe("");
  });
});

describe("failureText", () => {
  test("returns exactly '<context> failed'", () => {
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const err = new Error("something went wrong");
      expect(failureText("upload", err)).toBe("upload failed");
      expect(failureText("herdr read", err)).toBe("herdr read failed");
      expect(failureText("transcript read", err)).toBe("transcript read failed");
      expect(failureText("reply", err)).toBe("reply failed");
      expect(failureText("key send", err)).toBe("key send failed");
      expect(failureText("close pane", err)).toBe("close pane failed");
      expect(failureText("rename pane", err)).toBe("rename pane failed");
      expect(failureText("close tab", err)).toBe("close tab failed");
      expect(failureText("rename tab", err)).toBe("rename tab failed");
      expect(failureText("create tab", err)).toBe("create tab failed");
      expect(failureText("create space", err)).toBe("create space failed");
      expect(failureText("request", err)).toBe("request failed");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("the returned string does NOT contain the error's message or paths", () => {
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const err = new Error("/home/op/.local/state/sightr/push-subscriptions.json: EACCES");
      const result = failureText("transcript read", err);
      expect(result).toBe("transcript read failed");
      expect(result.includes("/home")).toBe(false);
      expect(result.includes("EACCES")).toBe(false);
      expect(result.includes("push-subscriptions.json")).toBe(false);
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("the real error is logged to console.error with full object", () => {
    const originalConsoleError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    const err = new Error("something internal");
    try {
      failureText("reply", err);
      expect(logged.length).toBe(1);
      expect(logged[0]![0]).toBe("[bridge] reply failed:");
      expect(logged[0]![1]).toBe(err);
    } finally {
      console.error = originalConsoleError;
    }
  });

  function orderedRequest(body: unknown): Request {
    return new Request("http://localhost/api/pane/w1%3Ap1/action", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  }


  class OrderedPaneClient {
    readonly calls: string[] = [];
    gate: Promise<void> | null = null;
    readPane(paneId: string): Promise<PaneRead> {
      return Promise.resolve({ pane_id: paneId, text: "", truncated: false, revision: 1 });
    }
    async sendPaneText(_paneId: string, text: string): Promise<void> {
      this.calls.push(`text:${text}`);
      if (this.gate) await this.gate;
    }
    async sendPaneKeys(_paneId: string, keys: string[]): Promise<void> {
      this.calls.push(`keys:${keys.join("+")}`);
    }
  }

  async function until(pred: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !pred(); i++) await new Promise((r) => setTimeout(r, 1));
    if (!pred()) throw new Error("condition never held");
  }

  test("concurrent replies remain ordered and whole", async () => {
    const client = new OrderedPaneClient();
    const queue = createPaneQueue();
    const first = replyPane(client as unknown as HerdrClient, cfg(), "w1:p1", orderedRequest({ text: "one" }), queue);
    await until(() => client.calls.length === 1);
    const second = replyPane(client as unknown as HerdrClient, cfg(), "w1:p1", orderedRequest({ text: "two" }), queue);
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(client.calls).toEqual(["text:one", "keys:Enter", "text:two", "keys:Enter"]);
  });

  test("keys during a reply land after Enter", async () => {
    const client = new OrderedPaneClient();
    const queue = createPaneQueue();
    const reply = replyPane(client as unknown as HerdrClient, cfg(), "w1:p1", orderedRequest({ text: "hi" }), queue);
    await until(() => client.calls.length === 1);
    const keys = keysPane(client as unknown as HerdrClient, cfg(), "w1:p1", orderedRequest({ keys: ["2"] }), queue);
    expect((await reply).status).toBe(200);
    expect((await keys).status).toBe(200);
    expect(client.calls).toEqual(["text:hi", "keys:Enter", "keys:2"]);
  });

  test("a stalled pane returns 503 to the next write", async () => {
    const client = new OrderedPaneClient();
    let rejectGate!: (reason?: unknown) => void;
    client.gate = new Promise<void>((_, reject) => { rejectGate = reject; });
    const queue = createPaneQueue(20);
    const first = replyPane(client as unknown as HerdrClient, cfg(), "w1:p1", orderedRequest({ text: "held" }), queue);
    await until(() => client.calls.length === 1);
    const second = await keysPane(client as unknown as HerdrClient, cfg(), "w1:p1", orderedRequest({ keys: ["2"] }), queue);
    expect(second.status).toBe(503);
    expect(await second.json()).toEqual({ ok: false, error: "pane busy" });
    expect(client.calls).not.toContain("keys:2");
    rejectGate(new Error("release"));
    await first;
  });

});



describe("runtime settings live reads", () => {
  test("device revoke and grant take effect without rebuilding config", async () => {
    const stateDir = await mkdtemp(join(process.env.TEMP ?? ".", "sightr-live-"));
    try {
      const c = cfg({ stateDir, deviceHeader: "x-device-id", deviceAllowlist: ["phone"] });
      const store = new RuntimeSettingsStore(c);
      const request = req({ host: "h", origin: "http://h", "x-device-id": "phone" });
      expect(guard(request, c, "write")).toBeNull();
      await store.set({ deviceAllowlist: [] });
      expect((guard(request, c, "write") as Response).status).toBe(403);
      await store.set({ deviceAllowlist: ["phone"] });
      expect(guard(request, c, "write")).toBeNull();
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  test("reply and pane reads use live settings", async () => {
    const stateDir = await mkdtemp(join(process.env.TEMP ?? ".", "sightr-live-"));
    try {
      const c = cfg({ stateDir, submitKeys: ["Enter"], readLines: 200 });
      const store = new RuntimeSettingsStore(c);
      const keys: string[][] = []; const reads: number[] = [];
      const client = {
        sendPaneText: async () => {}, sendPaneKeys: async (_id: string, value: string[]) => { keys.push(value); },
        readPane: async (id: string, _source: string, lines: number, _format: string) => { reads.push(lines); return { pane_id: id, text: "", truncated: false, revision: 1 }; },
      };
      await replyPane(client as unknown as HerdrClient, c, "w:p", new Request("http://h", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) }), createPaneQueue());
      expect(keys).toEqual([["Enter"]]); expect((await readPane(client as unknown as HerdrClient, c, "w:p", new URL("http://h/api/pane/w:p"), new Request("http://h"))).status).toBe(200);
      await store.set({ submitKeys: ["ctrl+j"], readLines: 500 });
      await replyPane(client as unknown as HerdrClient, c, "w:p", new Request("http://h", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) }), createPaneQueue());
      await replyPane(client as unknown as HerdrClient, c, "w:p", new Request("http://h", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x", submit_keys: ["ctrl+Enter"] }) }), createPaneQueue());
      await readPane(client as unknown as HerdrClient, c, "w:p", new URL("http://h/api/pane/w:p"), new Request("http://h"));
      expect(keys.at(-2)).toEqual(["ctrl+j"]); expect(keys.at(-1)).toEqual(["ctrl+Enter"]); expect(reads.at(-1)).toBe(500);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
});
