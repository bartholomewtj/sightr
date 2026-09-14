import { describe, expect, test } from "bun:test";

import { BEACON_HOOKS, buildBeaconRecord } from "./beacon-emit.ts";

// The emitter's whole decision, exercised as a pure function: no files, no live agent, no session
// ids that ever existed. What is pinned here is mostly what it REFUSES — the hook is installed
// globally, so it fires for every agent on the host, and the refusals are what keep it harmless.

const NOW = 1_700_000_000_000;
const IN_PANE = { HERDR_PANE_ID: "w1:p1" };
const payload = (over: Record<string, unknown> = {}) => JSON.stringify({ session_id: "sess-0001", ...over });
const build = (event: string, env: Record<string, string | undefined> = IN_PANE, text = payload()) => buildBeaconRecord(event, env, text, NOW);

describe("buildBeaconRecord", () => {
  test("names the pane, the session and what the agent is doing", () => {
    expect(build("UserPromptSubmit")).toEqual({
      schemaVersion: 1,
      harness: "claude",
      paneId: "w1:p1",
      session: { kind: "id", value: "sess-0001" },
      status: "working",
      heartbeatMs: NOW,
    });
  });

  test("every registered event maps to the status it means", () => {
    const statuses = Object.fromEntries(BEACON_HOOKS.map((h) => [h.event, build(h.event)?.status]));
    expect(statuses).toEqual({
      SessionStart: "idle",
      UserPromptSubmit: "working",
      Stop: "idle",
      SessionEnd: "idle",
      Notification: "waiting",
    });
  });

  test("writes nothing outside a Herdr pane — the cheapest gate, and the one that runs first", () => {
    expect(build("Stop", {})).toBeNull();
    expect(build("Stop", { HERDR_PANE_ID: "" })).toBeNull();
    expect(build("Stop", { HERDR_PANE_ID: "   " })).toBeNull();
    expect(build("Stop", { HERDR_PANE_ID: "../x" })).toBeNull();
  });

  test("writes nothing for an event nobody registered", () => {
    expect(build("PreToolUse")).toBeNull();
    expect(buildBeaconRecord(undefined, IN_PANE, payload(), NOW)).toBeNull();
  });

  test("a payload it cannot read is not an error, it is silence", () => {
    for (const text of ["", "{", "[]", "null", '"a string"']) {
      expect(build("Stop", IN_PANE, text), text).toBeNull();
    }
  });

  // A subagent's payload names a conversation the operator cannot see in that pane.
  test("refuses a subagent's payload", () => {
    expect(build("Stop", IN_PANE, payload({ agent_id: "sub-1" }))).toBeNull();
  });

  test("refuses a session id that could reach outside the journal root", () => {
    for (const bad of [undefined, "", "../../x", "a/b", true, 12, "x".repeat(200)]) {
      expect(build("Stop", IN_PANE, payload({ session_id: bad })), JSON.stringify(bad)).toBeNull();
    }
  });

  test("takes a session name when the harness sends one, and drops a bad one without the record", () => {
    expect(build("Stop", IN_PANE, payload({ session_name: "my-feature" }))?.sessionName).toBe("my-feature");
    for (const bad of ["line\nbreak", "x".repeat(500), 12, "  "]) {
      const record = build("Stop", IN_PANE, payload({ session_name: bad }));
      expect(record, JSON.stringify(bad)).not.toBeNull();
      expect("sessionName" in record!, JSON.stringify(bad)).toBe(false);
    }
  });
});
