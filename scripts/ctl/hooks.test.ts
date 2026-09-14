import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  claudeSettingsTargets,
  hookCommand,
  HOOK_MARKER,
  installDocument,
  markedCommandIn,
  markedCommandsByEvent,
  markerVersionOf,
  serializeSettings,
  uninstallDocument,
} from "./hooks.ts";

// The installer's decisions, as pure functions over a settings document — no temp files, and no
// test that could ever touch a real `.claude/settings.json`. What is pinned hardest is the operator's
// own hooks: Claude merges entries across settings levels, so their hooks live in the same arrays as
// ours, and an installer that reorders or drops one is the failure that matters.

const BUN = String.raw`C:\Users\you\.bun\bin\bun.exe`;
const SCRIPT = String.raw`C:\sightr\scripts\beacon-emit.ts`;
const install = (current: unknown) => installDocument(current, BUN, SCRIPT);
const doc = (result: ReturnType<typeof install>) => {
  if (result.kind !== "document") throw new Error(`expected a document, got: ${result.reason}`);
  return result.document as { hooks: Record<string, unknown[]> };
};
/** An entry the operator wrote themselves — no marker anywhere in it. */
const theirs = (command: string) => ({ hooks: [{ type: "command", command }] });

describe("claudeSettingsTargets", () => {
  test("the default profile, always", () => {
    expect(claudeSettingsTargets("/home/you", {})).toEqual([
      { dir: path.join("/home/you", ".claude"), path: path.join("/home/you", ".claude", "settings.json") },
    ]);
  });

  test("one more per configured profile, de-duplicated and with blanks dropped", () => {
    const targets = claudeSettingsTargets("/home/you", {
      SIGHTR_CLAUDE_ROOT: `/a/projects, ,/b/projects,${path.join("/home/you", ".claude", "projects")}`,
    });
    expect(targets.map((t) => t.dir)).toEqual([
      path.join("/home/you", ".claude"),
      path.dirname("/a/projects"),
      path.dirname("/b/projects"),
    ]);
  });
});

describe("the ownership marker", () => {
  test("our command carries it; an operator's does not", () => {
    const command = hookCommand(BUN, SCRIPT, "Stop");
    expect(command).toBe(`"${BUN}" "${SCRIPT}" Stop ${HOOK_MARKER}`);
    expect(markerVersionOf(command)).toBe(1);
    expect(markerVersionOf("my-own-hook.sh")).toBeNull();
    expect(markedCommandIn(theirs("my-own-hook.sh"))).toBeNull();
    expect(markedCommandIn({ hooks: "not an array" })).toBeNull();
    expect(markedCommandIn(null)).toBeNull();
  });
});

describe("installDocument", () => {
  test("creates all five events in a file that does not exist yet", () => {
    const hooks = doc(install(null)).hooks;
    expect(Object.keys(hooks).sort()).toEqual([
      "Notification",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
    // Only the notification hook is matched, and on the event's own matcher — never on its prose.
    expect((hooks.Notification![0] as { matcher?: string }).matcher).toBe("idle_prompt");
    expect((hooks.Stop![0] as { matcher?: string }).matcher).toBeUndefined();
  });

  test("installing twice is byte-identical — that is how `already installed` is decided", () => {
    const first = serializeSettings(doc(install(null)));
    const second = serializeSettings(doc(install(JSON.parse(first))));
    expect(second).toBe(first);
  });

  test("an operator's own entry keeps its index, and ours goes after it", () => {
    const hooks = doc(install({ hooks: { Stop: [theirs("mine.sh"), theirs("also-mine.sh")] } })).hooks;
    expect(markedCommandIn(hooks.Stop![0])).toBeNull();
    expect(markedCommandIn(hooks.Stop![1])).toBeNull();
    expect(markerVersionOf(markedCommandIn(hooks.Stop![2])!)).toBe(1);
    expect(hooks.Stop).toHaveLength(3);
  });

  test("a marked entry at another version is replaced IN PLACE, not appended", () => {
    const stale = { hooks: [{ type: "command", command: "old.exe # sightr-beacon v0" }] };
    const hooks = doc(install({ hooks: { Stop: [theirs("first.sh"), stale, theirs("last.sh")] } })).hooks;
    expect(hooks.Stop).toHaveLength(3);
    expect(markedCommandIn(hooks.Stop![0])).toBeNull(); // the operator's neighbours did not move
    expect(markerVersionOf(markedCommandIn(hooks.Stop![1])!)).toBe(1);
    expect(markedCommandIn(hooks.Stop![2])).toBeNull();
  });

  test("refuses a shape it cannot merge into, naming the exact thing", () => {
    expect(install([]).kind).toBe("refuse");
    expect(install("nope").kind).toBe("refuse");
    const badHooks = install({ hooks: "nope" });
    expect(badHooks.kind === "refuse" && badHooks.reason).toContain("`hooks`");
    const badEvent = install({ hooks: { Stop: { not: "an array" } } });
    expect(badEvent.kind === "refuse" && badEvent.reason).toContain("hooks.Stop");
  });
});

describe("uninstallDocument", () => {
  test("removes only what we own, and tidies up after itself", () => {
    const installed = doc(install({ hooks: { Stop: [theirs("mine.sh")] } }));
    const after = doc(uninstallDocument(installed)) as unknown as { hooks?: Record<string, unknown[]> };
    expect(after.hooks!.Stop).toHaveLength(1);
    expect(markedCommandIn(after.hooks!.Stop![0])).toBeNull();
    // Events where only our entry lived are dropped rather than left as empty arrays.
    expect("UserPromptSubmit" in after.hooks!).toBe(false);
  });

  test("a document that was only ever ours loses its `hooks` key entirely", () => {
    const after = doc(uninstallDocument(doc(install(null)))) as Record<string, unknown>;
    expect("hooks" in after).toBe(false);
  });

  test("leaves a document with no hooks alone", () => {
    const untouched: Record<string, unknown> = doc(uninstallDocument({ model: "opus" }));
    expect(untouched).toEqual({ model: "opus" });
  });
});

describe("markedCommandsByEvent", () => {
  test("reports which events are ours and which are still missing", () => {
    const installed = doc(install(null));
    delete installed.hooks.Stop;
    delete installed.hooks.SessionEnd;
    const commands = markedCommandsByEvent(installed);
    expect(commands.filter((c) => c === null)).toHaveLength(2);
    expect(commands.filter((c) => c !== null)).toHaveLength(3);
    expect(markedCommandsByEvent(null).every((c) => c === null)).toBe(true);
  });
});

describe("serializeSettings", () => {
  test("indents like an editor and ends with exactly one newline", () => {
    const text = serializeSettings({ a: 1 });
    expect(text).toBe('{\n  "a": 1\n}\n');
  });
});
