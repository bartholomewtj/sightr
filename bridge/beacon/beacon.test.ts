import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { beaconsByPane, decorateAgent, identityOf } from "./decorate.ts";
import { beaconLiveness } from "./liveness.ts";
import { parseBeacon } from "./parse.ts";
import { beaconFileName, beaconsDir, isPaneId, paneIdOf, resolveStateDir } from "./paths.ts";
import { readBeacons, type BeaconDirectory } from "./reader.ts";
import { BEACON_TTL_MS, type BeaconReading } from "./types.ts";
import type { AgentView } from "../state-engine.ts";

// Every rule a beacon carries, exercised with no temp files and no live process: the paths are pure
// string work, the parse is total over garbage, the TTL split is arithmetic, and the sweep runs
// against an in-memory directory. Nothing here uses a real session id or a real pane.

const NOW = 1_700_000_000_000;

// ── paths ────────────────────────────────────────────────────────────────────────────────────

describe("the pane-id grammar", () => {
  test("accepts what Herdr actually names a pane", () => {
    expect(isPaneId("w1:p1")).toBe(true);
    expect(isPaneId("a")).toBe(true);
    expect(isPaneId(`a${"b".repeat(63)}`)).toBe(true); // 64 chars
  });

  test("refuses anything that could reach a path", () => {
    for (const bad of ["", "a/b", "a\\b", "..", "../x", "a b", "%TEMP%", "a~b", "-lead", `a${"b".repeat(64)}`]) {
      expect(isPaneId(bad), bad).toBe(false);
    }
  });
});

describe("beaconFileName / paneIdOf", () => {
  test("round-trips every legal id — `:` is the one character NTFS refuses", () => {
    for (const id of ["w1:p1", "a", "pane.1", "w1:p1:x", "A-B_c"]) {
      const name = beaconFileName(id);
      expect(name, id).not.toBeNull();
      expect(paneIdOf(name!), id).toBe(id);
    }
    expect(beaconFileName("w1:p1")).toBe("w1~p1.json");
  });

  test("refuses an id the grammar refuses, so nothing outside it names a file", () => {
    expect(beaconFileName("../../etc/passwd")).toBeNull();
    expect(beaconFileName("")).toBeNull();
  });

  test("reads back only our own names", () => {
    expect(paneIdOf("notes.txt")).toBeNull();
    expect(paneIdOf(".json")).toBeNull();
    expect(paneIdOf("..json")).toBeNull();
  });

  test("beaconsDir hangs off the state dir, and the state dir is resolved once for both sides", () => {
    expect(beaconsDir("/state")).toBe(join("/state", "beacons"));
    expect(resolveStateDir({ HERDR_PLUGIN_STATE_DIR: "/herdr" }, "/home/you")).toBe("/herdr");
    expect(resolveStateDir({ SIGHTR_STATE_DIR: "/mine" }, "/home/you")).toBe("/mine");
    expect(resolveStateDir({}, "/home/you")).toContain("sightr");
    // A launcher that exports the variable empty means "unset", not "the current directory".
    expect(resolveStateDir({ HERDR_PLUGIN_STATE_DIR: "", SIGHTR_STATE_DIR: "/mine" }, "/home/you")).toBe("/mine");
    expect(resolveStateDir({ SIGHTR_STATE_DIR: "  " }, "/home/you")).toContain("sightr");
  });
});

// ── liveness ─────────────────────────────────────────────────────────────────────────────────

describe("the TTL split", () => {
  test("exactly at the TTL is live; one millisecond past it is not", () => {
    expect(beaconLiveness(NOW - BEACON_TTL_MS, NOW)).toBe("live");
    expect(beaconLiveness(NOW - BEACON_TTL_MS - 1, NOW)).toBe("expired");
    expect(beaconLiveness(NOW, NOW)).toBe("live");
  });

  test("a heartbeat in the future is expired — a hand-edited file cannot pin a status forever", () => {
    expect(beaconLiveness(NOW + 1, NOW)).toBe("expired");
    expect(beaconLiveness(0, NOW)).toBe("expired");
  });
});

// ── parse ────────────────────────────────────────────────────────────────────────────────────

const good = {
  schemaVersion: 1,
  harness: "claude",
  paneId: "w1:p1",
  session: { kind: "id", value: "sess-0001" },
  status: "working",
  heartbeatMs: NOW,
};
const doc = (over: Record<string, unknown> = {}) => JSON.stringify({ ...good, ...over });

describe("parseBeacon", () => {
  test("reads a well-formed record", () => {
    expect(parseBeacon(doc())).toEqual({
      schemaVersion: 1,
      harness: "claude",
      paneId: "w1:p1",
      session: { kind: "id", value: "sess-0001" },
      status: "working",
      heartbeatMs: NOW,
    });
  });

  test("is total over garbage — no input throws", () => {
    for (const bad of ["", "not json", "{", "[]", "null", "12", '"a string"']) {
      expect(parseBeacon(bad), bad).toBeNull();
    }
  });

  test("skips a schema it does not know rather than guessing at it", () => {
    expect(parseBeacon(doc({ schemaVersion: 2 }))).toBeNull();
    expect(parseBeacon(doc({ schemaVersion: 0 }))).toBeNull();
    expect(parseBeacon(doc({ schemaVersion: "1" }))).toBeNull();
  });

  test("refuses a record whose fields are not what they claim", () => {
    expect(parseBeacon(doc({ harness: "" }))).toBeNull();
    expect(parseBeacon(doc({ harness: "x".repeat(5000) }))).toBeNull();
    expect(parseBeacon(doc({ paneId: "../../etc/passwd" }))).toBeNull();
    expect(parseBeacon(doc({ session: { kind: "url", value: "http://x" } }))).toBeNull();
    expect(parseBeacon(doc({ session: { kind: "id", value: "" } }))).toBeNull();
    expect(parseBeacon(doc({ status: "busy" }))).toBeNull();
    expect(parseBeacon(doc({ heartbeatMs: "now" }))).toBeNull();
    expect(parseBeacon(doc({ heartbeatMs: 1e999 }))).toBeNull(); // Infinity
    expect(parseBeacon(doc({ heartbeatMs: -1 }))).toBeNull();
  });

  test("a path ref stays parseable — containment, not the parse, is what confines it", () => {
    expect(parseBeacon(doc({ session: { kind: "path", value: "/logs/a.jsonl" } }))?.session).toEqual({
      kind: "path",
      value: "/logs/a.jsonl",
    });
  });

  test("a bad session name drops the FIELD, never the record", () => {
    expect(parseBeacon(doc({ sessionName: "my-feature" }))?.sessionName).toBe("my-feature");
    for (const bad of ["line\none", "x".repeat(500), 12, "", "   "]) {
      const record = parseBeacon(doc({ sessionName: bad }));
      expect(record, JSON.stringify(bad)).not.toBeNull();
      expect("sessionName" in record!, JSON.stringify(bad)).toBe(false);
    }
  });
});

// ── the sweep ────────────────────────────────────────────────────────────────────────────────

function fakeDirectory(files: Record<string, string | null | "throws">): BeaconDirectory {
  return {
    list: () => Promise.resolve(Object.keys(files)),
    read: (name) => {
      const value = files[name];
      if (value === "throws") throw new Error("read blew up");
      return Promise.resolve(value ?? null);
    },
  };
}
const sweep = (directory: BeaconDirectory) => readBeacons({ directory, now: () => NOW });

describe("readBeacons", () => {
  test("a live beacon keeps its status; an expired one has no status key at all", async () => {
    const live = await sweep(fakeDirectory({ "w1~p1.json": doc() }));
    expect(live).toEqual([
      { liveness: "live", paneId: "w1:p1", harness: "claude", session: { kind: "id", value: "sess-0001" }, status: "working" },
    ]);

    const stale = await sweep(fakeDirectory({ "w1~p1.json": doc({ heartbeatMs: NOW - BEACON_TTL_MS - 1 }) }));
    expect(stale[0]!.liveness).toBe("expired");
    expect("status" in stale[0]!).toBe(false);
    expect(stale[0]!.session).toEqual({ kind: "id", value: "sess-0001" }); // history is still history
  });

  test("an unlistable directory is not an error — it is the first run", async () => {
    expect(await readBeacons({ directory: { list: () => Promise.resolve(null), read: () => Promise.resolve(null) } })).toEqual([]);
    expect(
      await readBeacons({
        directory: {
          list: () => Promise.reject(new Error("gone")),
          read: () => Promise.resolve(null),
        },
      }),
    ).toEqual([]);
  });

  test("skips everything it cannot believe, and never throws doing it", async () => {
    const readings = await sweep(
      fakeDirectory({
        "notes.txt": doc(), //            not one of ours
        "w1~p2.json": null, //            vanished mid-sweep
        "w1~p3.json": "throws", //        a read that blew up
        "w1~p4.json": "{ torn", //        a torn write
        "w1~p5.json": doc({ schemaVersion: 9 }), // a schema we do not know
        "w1~p6.json": doc(), //           a record naming w1:p1, under another pane's name
      }),
    );
    expect(readings).toEqual([]);
  });

  test("orders by pane so the output is deterministic", async () => {
    const readings = await sweep(
      fakeDirectory({
        "w2~p1.json": doc({ paneId: "w2:p1" }),
        "w1~p1.json": doc(),
      }),
    );
    expect(readings.map((r) => r.paneId)).toEqual(["w1:p1", "w2:p1"]);
  });
});

// ── decoration ───────────────────────────────────────────────────────────────────────────────

const reading = (over: Partial<BeaconReading> = {}): BeaconReading =>
  ({
    liveness: "live",
    paneId: "w1:p1",
    harness: "claude",
    session: { kind: "id", value: "sess-0001" },
    status: "working",
    ...over,
  }) as BeaconReading;

const view = (over: Partial<AgentView> = {}): AgentView => ({
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "one",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "idle",
  cwd: "/home/you/demo",
  focused: false,
  ...over,
});

describe("identityOf", () => {
  test("maps the three beacon words onto Sightr's five", () => {
    expect(identityOf(reading({ status: "working" }))!.status).toBe("working");
    expect(identityOf(reading({ status: "idle" }))!.status).toBe("idle");
    // The one that matters: an agent waiting on a human belongs at the top of triage.
    expect(identityOf(reading({ status: "waiting" }))!.status).toBe("blocked");
  });

  test("an expired reading carries no status key", () => {
    const identity = identityOf({
      liveness: "expired",
      paneId: "w1:p1",
      harness: "claude",
      session: { kind: "id", value: "sess-0001" },
    })!;
    expect("status" in identity).toBe(false);
    expect(identity.session).toEqual({ kind: "id", value: "sess-0001" });
  });

  test("normalises a harness name, and refuses one that could never name an adapter", () => {
    expect(identityOf(reading({ harness: "CLAUDE  " }))!.agent).toBe("claude");
    for (const bad of ["", "../x", "Claude Code", "x".repeat(40), "/claude"]) {
      expect(identityOf(reading({ harness: bad })), bad).toBeNull();
    }
  });
});

describe("decorateAgent", () => {
  test("returns the very same view when there is no beacon", () => {
    const original = view();
    expect(decorateAgent(original, undefined)).toBe(original);
  });

  test("writes the session ref, the name and the status — and nothing else", () => {
    const decorated = decorateAgent(
      view(),
      identityOf(reading({ status: "waiting", sessionName: "my-feature" }))!,
    );
    expect(decorated.agentSession).toEqual({ kind: "id", value: "sess-0001" });
    expect(decorated.sessionName).toBe("my-feature");
    expect(decorated.status).toBe("blocked");
    expect(decorated.agent).toBe("claude"); // never promoted, never renamed
    expect(decorated.paneId).toBe("w1:p1");
  });

  test("a field the beacon does not supply stays absent, not undefined", () => {
    const decorated = decorateAgent(view(), identityOf(reading())!);
    expect("sessionName" in decorated).toBe(false);
  });

  test("an expired beacon leaves the poll's own status alone", () => {
    const identity = identityOf({
      liveness: "expired",
      paneId: "w1:p1",
      harness: "claude",
      session: { kind: "id", value: "sess-0001" },
    })!;
    const decorated = decorateAgent(view({ status: "working" }), identity);
    expect(decorated.status).toBe("working");
    expect(decorated.agentSession).toEqual({ kind: "id", value: "sess-0001" });
  });
});

describe("beaconsByPane", () => {
  test("keys by pane and drops a reading whose harness is unusable", () => {
    const byPane = beaconsByPane([reading(), reading({ paneId: "w1:p2", harness: "Claude Code" })]);
    expect([...byPane.keys()]).toEqual(["w1:p1"]);
  });
});
