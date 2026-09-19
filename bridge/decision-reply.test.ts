import { describe, expect, test } from "bun:test";
import { parseDecisionMarker, parseDecisionMarkerLine } from "./decision-marker.ts";
import { buildDecisionPayload } from "./decision-payload.ts";
import { submitDecisionReply, type SpawnRunner } from "./decision-reply.ts";
import { decisionReplyPane } from "./decision-reply-routes.ts";
import { keysPane } from "./pane-write-routes.ts";
import { createPaneQueue } from "./pane-queue.ts";
import { FakeHerdrClient } from "./test/fake-herdr.ts";
import type { Config } from "./config.ts";

function fakeCfg(): Config {
  return {
    socketPath: "/tmp/herdr.sock",
    port: 8787,
    host: "127.0.0.1",
    allowNonLoopbackBind: false,
    pollMs: 1500,
    pollIdleMs: 12_000,
    notifyDelayMs: 30_000,
    readLines: 200,
    transcript: false,
    journalRoots: { claude: [], pi: [], grok: [] },
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
  };
}

function jsonPostReq(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1:8787",
      origin: "http://127.0.0.1:8787",
    },
    body: JSON.stringify(body),
  });
}

describe("Operator-decision answer bridge (whistlr-31f)", () => {
  // Test 1: Marked grok-shaped card → pick option → whistlr reply argv has --thread, --payload, --schema whistlr.decision_response.v1; no key send.
  test("1. Marked grok-shaped card → pick option → whistlr reply argv has --thread, --payload, --schema whistlr.decision_response.v1; no key send", async () => {
    const grokCard = [
      "┃ Which color theme should the dashboard use?",
      "┃ whistlr.decision thread=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee run=5a81defb",
      "┃",
      "┃ 1 (○) Red      Warm red palette",
      "┃ 2 (○) Green    Calm green palette",
      "┃ 3 (○) Blue     Cool blue palette",
      "┃ z (○) Type your answer here",
      "┃",
      "┃ ↑/↓ navigate · Enter:submit",
      "Tab:next answer",
    ].join("\n");

    const spawnCalls: string[][] = [];
    const mockRunner: SpawnRunner = async (cmd: string[]) => {
      spawnCalls.push(cmd);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };

    const fakeHerdr = new FakeHerdrClient();
    const queue = createPaneQueue();
    const req = jsonPostReq("http://127.0.0.1:8787/api/pane/ws1:p1/decision-reply", {
      cardText: grokCard,
      option: { keyLabel: "1", keys: ["1"], label: "Red" },
    });

    const res = await decisionReplyPane(
      fakeHerdr as any,
      fakeCfg(),
      "ws1:p1",
      req,
      queue,
      undefined,
      mockRunner,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);

    // Verify whistlr reply argv
    expect(spawnCalls).toHaveLength(1);
    const cmd = spawnCalls[0]!;
    expect(cmd[0]).toBe("whistlr");
    expect(cmd[1]).toBe("reply");

    const threadIdx = cmd.indexOf("--thread");
    expect(threadIdx).toBeGreaterThan(-1);
    expect(cmd[threadIdx + 1]).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    const payloadIdx = cmd.indexOf("--payload");
    expect(payloadIdx).toBeGreaterThan(-1);
    const payload = JSON.parse(cmd[payloadIdx + 1]!);
    expect(payload).toEqual({ answers: { q1: "1" } });

    const schemaIdx = cmd.indexOf("--schema");
    expect(schemaIdx).toBeGreaterThan(-1);
    expect(cmd[schemaIdx + 1]).toBe("whistlr.decision_response.v1");

    // No key send
    expect(fakeHerdr.keys).toHaveLength(0);
    expect(fakeHerdr.texts).toHaveLength(0);
  });

  // Test 2: Marked claude-shaped card → same.
  test("2. Marked claude-shaped card → pick option → whistlr reply argv has --thread, --payload, --schema whistlr.decision_response.v1; no key send", async () => {
    const claudeCard = [
      "Which color theme should the dashboard use?",
      "",
      "❯ 1. Red",
      "  2. Green",
      "  3. Blue",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
      "whistlr.decision thread=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee run=5a81defb",
    ].join("\n");

    const spawnCalls: string[][] = [];
    const mockRunner: SpawnRunner = async (cmd: string[]) => {
      spawnCalls.push(cmd);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };

    const fakeHerdr = new FakeHerdrClient();
    const queue = createPaneQueue();
    const req = jsonPostReq("http://127.0.0.1:8787/api/pane/ws1:p1/decision-reply", {
      cardText: claudeCard,
      option: { keys: ["2", "Enter"], label: "Green" },
    });

    const res = await decisionReplyPane(
      fakeHerdr as any,
      fakeCfg(),
      "ws1:p1",
      req,
      queue,
      undefined,
      mockRunner,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);

    // Verify whistlr reply argv
    expect(spawnCalls).toHaveLength(1);
    const cmd = spawnCalls[0]!;
    expect(cmd[0]).toBe("whistlr");
    expect(cmd[1]).toBe("reply");

    const threadIdx = cmd.indexOf("--thread");
    expect(threadIdx).toBeGreaterThan(-1);
    expect(cmd[threadIdx + 1]).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

    const payloadIdx = cmd.indexOf("--payload");
    expect(payloadIdx).toBeGreaterThan(-1);
    const payload = JSON.parse(cmd[payloadIdx + 1]!);
    expect(payload).toEqual({ answers: { q1: "2" } });

    const schemaIdx = cmd.indexOf("--schema");
    expect(schemaIdx).toBeGreaterThan(-1);
    expect(cmd[schemaIdx + 1]).toBe("whistlr.decision_response.v1");

    // No key send
    expect(fakeHerdr.keys).toHaveLength(0);
    expect(fakeHerdr.texts).toHaveLength(0);
  });

  // Also test marked pi-shaped card
  test("2b. Marked pi-shaped card → pick option → whistlr reply argv has --thread, --payload, --schema whistlr.decision_response.v1; no key send", async () => {
    const piCard = [
      "──────────────────────────────────────────────────────────────────────────────",
      "  which fruit should the test pick?",
      "  whistlr.decision thread=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee run=5a81defb",
      "",
      "> 1. Apple",
      "   2. Banana",
      "   3. Cherry",
      "   4. Type something.",
      "",
      "  ↑↓ navigate • Enter select • Esc cancel",
      "──────────────────────────────────────────────────────────────────────────────",
    ].join("\n");

    const spawnCalls: string[][] = [];
    const mockRunner: SpawnRunner = async (cmd: string[]) => {
      spawnCalls.push(cmd);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };

    const fakeHerdr = new FakeHerdrClient();
    const queue = createPaneQueue();
    const req = jsonPostReq("http://127.0.0.1:8787/api/pane/ws1:p1/decision-reply", {
      cardText: piCard,
      option: { keyLabel: "3", keys: ["Down", "Down", "Enter"], label: "Cherry" },
    });

    const res = await decisionReplyPane(
      fakeHerdr as any,
      fakeCfg(),
      "ws1:p1",
      req,
      queue,
      undefined,
      mockRunner,
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);

    expect(spawnCalls).toHaveLength(1);
    const cmd = spawnCalls[0]!;
    const payloadIdx = cmd.indexOf("--payload");
    const payload = JSON.parse(cmd[payloadIdx + 1]!);
    expect(payload).toEqual({ answers: { q1: "3" } });

    expect(fakeHerdr.keys).toHaveLength(0);
  });

  // Test 3: Unmarked prompt-select → keys only; no whistlr spawn.
  test("3. Unmarked prompt-select → keys only; no whistlr spawn", async () => {
    const unmarkedCard = [
      "Which color theme should the dashboard use?",
      "",
      "❯ 1. Red",
      "  2. Green",
      "  3. Blue",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");

    // Parse confirms this card is NOT marked
    const marker = parseDecisionMarker(unmarkedCard);
    expect(marker.kind).toBe("none");

    const spawnCalls: string[][] = [];
    const mockRunner: SpawnRunner = async (cmd: string[]) => {
      spawnCalls.push(cmd);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };

    // An unmarked card takes the existing keys path (/api/pane/:id/keys)
    const fakeHerdr = new FakeHerdrClient();
    const queue = createPaneQueue();
    const keysReq = jsonPostReq("http://127.0.0.1:8787/api/pane/ws1:p1/keys", {
      keys: ["1", "Enter"],
    });

    const res = await keysPane(fakeHerdr as any, fakeCfg(), "ws1:p1", keysReq, queue);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);

    // Keys were sent to the pane
    expect(fakeHerdr.keys).toEqual([["ws1:p1", ["1", "Enter"]]]);

    // Also verify decision-reply route refuses to spawn on unmarked card
    const decRes = await decisionReplyPane(
      fakeHerdr as any,
      fakeCfg(),
      "ws1:p1",
      jsonPostReq("http://127.0.0.1:8787/api/pane/ws1:p1/decision-reply", {
        cardText: unmarkedCard,
        option: { keys: ["1"], label: "Red" },
      }),
      queue,
      undefined,
      mockRunner,
    );
    expect(((await decRes.json()) as any).ok).toBe(false);
    // No whistlr spawn
    expect(spawnCalls).toHaveLength(0);
  });

  // Test 4: Marker parse refuses a truncated / missing thread id (no spawn).
  test("4. Marker parse refuses a truncated / missing thread id (no spawn)", async () => {
    // 4a. Pure parse refuses truncated thread id
    const truncatedThread = "whistlr.decision thread=aaaaaaaa-bbbb run=5a81defb";
    const resTrunc = parseDecisionMarkerLine(truncatedThread);
    expect(resTrunc.kind).toBe("refused");

    // 4b. Pure parse refuses missing thread id
    const missingThread = "whistlr.decision run=5a81defb";
    const resMissing = parseDecisionMarkerLine(missingThread);
    expect(resMissing.kind).toBe("refused");

    // 4c. Pure parse refuses empty thread id
    const emptyThread = "whistlr.decision thread= run=5a81defb";
    const resEmpty = parseDecisionMarkerLine(emptyThread);
    expect(resEmpty.kind).toBe("refused");

    // 4d. Multi-line parse refuses when card contains truncated thread
    const cardWithTruncated = [
      "Which color theme should the dashboard use?",
      "whistlr.decision thread=1234 run=5a81defb",
      "1. Red",
      "2. Blue",
    ].join("\n");
    const resCard = parseDecisionMarker(cardWithTruncated);
    expect(resCard.kind).toBe("refused");

    // 4e. Decision-reply route refuses when marker has truncated thread (no spawn, no key send)
    const spawnCalls: string[][] = [];
    const mockRunner: SpawnRunner = async (cmd: string[]) => {
      spawnCalls.push(cmd);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };

    const fakeHerdr = new FakeHerdrClient();
    const queue = createPaneQueue();
    const req = jsonPostReq("http://127.0.0.1:8787/api/pane/ws1:p1/decision-reply", {
      cardText: cardWithTruncated,
      option: { keys: ["1"], label: "Red" },
    });

    const routeRes = await decisionReplyPane(
      fakeHerdr as any,
      fakeCfg(),
      "ws1:p1",
      req,
      queue,
      undefined,
      mockRunner,
    );

    const json = (await routeRes.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/thread/i);

    // No whistlr spawn, no key send
    expect(spawnCalls).toHaveLength(0);
    expect(fakeHerdr.keys).toHaveLength(0);
    expect(fakeHerdr.texts).toHaveLength(0);

    // 4f. Decision-reply route refuses when decision object has truncated thread
    const spawnCalls2: string[][] = [];
    const mockRunner2: SpawnRunner = async (cmd: string[]) => {
      spawnCalls2.push(cmd);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };

    const req2 = jsonPostReq("http://127.0.0.1:8787/api/pane/ws1:p1/decision-reply", {
      decision: { thread: "truncated-id", run: "5a81defb" },
      option: { keys: ["1"], label: "Red" },
    });
    const routeRes2 = await decisionReplyPane(
      fakeHerdr as any,
      fakeCfg(),
      "ws1:p1",
      req2,
      queue,
      undefined,
      mockRunner2,
    );
    const json2 = (await routeRes2.json()) as { ok: boolean; error: string };
    expect(json2.ok).toBe(false);
    expect(spawnCalls2).toHaveLength(0);
    expect(fakeHerdr.keys).toHaveLength(0);
  });

  // Test 5: Payload maps the selected option id/label onto answers.
  test("5. Payload maps the selected option id/label onto answers", () => {
    // 5a. Option with keyLabel
    const p1 = buildDecisionPayload({
      keyLabel: "1",
      keys: ["Tab", "1"],
      label: "Red",
    });
    expect(p1).toEqual({ answers: { q1: "1" } });

    // 5b. Option with digit in keys (no keyLabel)
    const p2 = buildDecisionPayload({
      keys: ["2", "Enter"],
      label: "Green",
    });
    expect(p2).toEqual({ answers: { q1: "2" } });

    // 5c. Option with digit in keys alone
    const p3 = buildDecisionPayload({
      keys: ["3"],
      label: "Blue",
    });
    expect(p3).toEqual({ answers: { q1: "3" } });

    // 5d. Option without digit or keyLabel uses option label
    const p4 = buildDecisionPayload({
      keys: ["y"],
      label: "Yes",
    });
    expect(p4).toEqual({ answers: { q1: "Yes" } });

    // 5e. Option with custom qid
    const p5 = buildDecisionPayload(
      { keyLabel: "1", label: "Red" },
      { qid: "custom_q" },
    );
    expect(p5).toEqual({ answers: { custom_q: "1" } });

    // 5f. Notes included when provided
    const p6 = buildDecisionPayload(
      { keyLabel: "1", label: "Red" },
      { notes: "operator added note" },
    );
    expect(p6).toEqual({
      answers: { q1: "1" },
      notes: "operator added note",
    });

    // 5g. Notes omitted when not provided or empty
    const p7 = buildDecisionPayload(
      { keyLabel: "1", label: "Red" },
      { notes: "   " },
    );
    expect(p7).toEqual({ answers: { q1: "1" } });
    expect(p7.notes).toBeUndefined();
  });

  // Direct submitDecisionReply unit test
  test("submitDecisionReply formats argv and invokes runner", async () => {
    const invocations: string[][] = [];
    const runner: SpawnRunner = async (cmd: string[]) => {
      invocations.push(cmd);
      return { exitCode: 0, stdout: "done" };
    };

    const res = await submitDecisionReply({
      thread: "11111111-2222-3333-4444-555555555555",
      payload: { answers: { q1: "test" } },
      runner,
    });

    expect(res.ok).toBe(true);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toEqual([
      "whistlr",
      "reply",
      "--thread",
      "11111111-2222-3333-4444-555555555555",
      "--payload",
      '{"answers":{"q1":"test"}}',
      "--schema",
      "whistlr.decision_response.v1",
    ]);
  });

  // Additional parse edge cases per contract
  test("marker parse rules: lookalikes, missing run, extra tokens", () => {
    // Missing run -> not a marked card (none)
    expect(
      parseDecisionMarkerLine(
        "whistlr.decision thread=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      ).kind,
    ).toBe("none");

    // Extra tokens break the line -> not a marked card (none)
    expect(
      parseDecisionMarkerLine(
        "whistlr.decision thread=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee run=5a81defb extra",
      ).kind,
    ).toBe("none");

    expect(
      parseDecisionMarkerLine(
        "prefix whistlr.decision thread=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee run=5a81defb",
      ).kind,
    ).toBe("none");

    // Lookalike without whistlr.decision -> not a marked card (none)
    expect(
      parseDecisionMarkerLine(
        "whistlr_decision thread=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee run=5a81defb",
      ).kind,
    ).toBe("none");

    // Case-insensitivity for hex
    const upper = parseDecisionMarkerLine(
      "whistlr.decision thread=AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE run=5A81DEFB",
    );
    expect(upper).toEqual({
      kind: "found",
      thread: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      run: "5a81defb",
    });
  });
});
