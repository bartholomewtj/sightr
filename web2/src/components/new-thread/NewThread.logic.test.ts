import { describe, expect, it } from "vitest";

import { buildLaunchArgs, capabilitiesFor, launchFor } from "@shared/agents";
import { project, thread } from "@/test/fixtures";

import {
  changeLabel,
  commandPreview,
  createPayload,
  harnessTiles,
  modelError,
  nameFromMessage,
  NO_JOURNAL_NOTE,
  phaseForThread,
  pickersFor,
  PLAIN_SHELL_ID,
  projectEntries,
  searchProjects,
  splitSource,
  startRefusalText,
  type DraftForCommand,
} from "./NewThread.logic";

const draft = (over: Partial<DraftForCommand> = {}): DraftForCommand => ({
  projectId: "w1",
  harness: "claude",
  model: "",
  effort: "",
  permissionMode: "",
  placement: "tab",
  direction: "right",
  name: "",
  ...over,
});

describe("harness tiles", () => {
  it("one tile per descriptor with a launch spec, then Terminal only", () => {
    const tiles = harnessTiles([
      { id: "claude", label: "Claude Code", launch: { kind: "claude" } },
      { id: "nolaunch", label: "No launch" },
      { id: "agy", label: "Antigravity CLI", launch: { kind: "agy" } },
    ]);
    expect(tiles.map((t) => t.id)).toEqual(["claude", "agy", PLAIN_SHELL_ID]);
    expect(tiles.at(-1)).toMatchObject({ label: "Terminal only", plainShell: true, note: null });
  });

  it("notes a harness with no journal, from capabilitiesFor().hasJournal", () => {
    const tiles = harnessTiles();
    for (const t of tiles.filter((x) => !x.plainShell)) {
      expect(t.note).toBe(capabilitiesFor(t.id).hasJournal ? null : NO_JOURNAL_NOTE);
    }
    expect(tiles.find((t) => t.id === "agy")?.note).toBe(NO_JOURNAL_NOTE);
    expect(tiles.find((t) => t.id === "claude")?.note).toBeNull();
  });
});

describe("pickers", () => {
  it("come from the launch table and are hidden when the harness has none", () => {
    const claude = pickersFor("claude");
    expect(claude.models?.map((m) => m.id)).toEqual(launchFor("claude")!.models!.map((m) => m.id));
    expect(claude.efforts).toEqual(launchFor("claude")!.efforts);
    expect(claude.modes?.some((m) => m.destructive)).toBe(true);
    // pi has no permission-mode flag; cursor launches with no flags at all.
    expect(pickersFor("pi").modes).toBeNull();
    expect(pickersFor("cursor")).toMatchObject({ models: null, efforts: null, modes: null });
    expect(pickersFor(PLAIN_SHELL_ID)).toMatchObject({ models: null, efforts: null, modes: null });
    expect(pickersFor(null)).toMatchObject({ models: null, efforts: null, modes: null });
  });

  it("'Can change after start' follows the capability flags", () => {
    for (const id of ["claude", "pi", "grok", "agy"]) {
      const caps = capabilitiesFor(id);
      const live = pickersFor(id).live;
      expect(live).toEqual({ model: caps.canSwitchModel, effort: caps.canSetEffortLive, mode: caps.canSwitchPermissionMode });
    }
    expect(changeLabel(true)).toBe("Can change after start");
    expect(changeLabel(false)).toBe("Fixed at start");
    // Bart, 17 Oct 2026: Claude's model is chosen at spawn only.
    expect(changeLabel(pickersFor("claude").live.model)).toBe("Fixed at start");
  });

  it("accepts a suggestion or a free-text model matching MODEL_PATTERN", () => {
    expect(modelError("claude", "")).toBeNull();
    expect(modelError("claude", "haiku")).toBeNull();
    expect(modelError("claude", "claude-sonnet-5-5")).toBeNull();
    expect(modelError("claude", "--evil")).not.toBeNull();
    expect(modelError("claude", "a b")).not.toBeNull();
  });
});

describe("command preview", () => {
  it("equals buildLaunchArgs for the same ids, after herdr's kind", () => {
    const cases = [
      { harness: "claude", model: "haiku", effort: "low", permissionMode: "plan" },
      { harness: "pi", model: "claude-haiku-5-5", effort: "minimal", permissionMode: "" },
      { harness: "grok", model: "", effort: "", permissionMode: "acceptEdits" },
      { harness: "codex", model: "", effort: "", permissionMode: "" },
    ];
    for (const c of cases) {
      const built = buildLaunchArgs(c.harness, {
        ...(c.model ? { model: c.model } : {}),
        ...(c.effort ? { effort: c.effort } : {}),
        ...(c.permissionMode ? { permissionMode: c.permissionMode } : {}),
      });
      expect(built.ok).toBe(true);
      expect(commandPreview(c)).toBe([launchFor(c.harness)!.kind, ...(built.ok ? built.args : [])].join(" "));
    }
    expect(commandPreview({ harness: "claude", model: "--x", effort: "", permissionMode: "" })).toBeNull();
    expect(commandPreview({ harness: PLAIN_SHELL_ID, model: "", effort: "", permissionMode: "" })).toBe("A shell, no agent");
  });
});

describe("createPayload", () => {
  it("sends ids, never arguments; tab by default", () => {
    const out = createPayload(draft({ model: "haiku", permissionMode: "plan", name: "Fix login" }), null, false);
    expect(out).toEqual({
      ok: true,
      payload: { projectId: "w1", harness: "claude", model: "haiku", permissionMode: "plan", name: "Fix login", placement: "tab" },
    });
  });

  it("splits next to the open thread with a direction", () => {
    const from = thread("t1");
    const out = createPayload(draft({ placement: "split", direction: "down" }), from, false);
    expect(out).toEqual({ ok: true, payload: { projectId: "w1", harness: "claude", placement: "split", splitFrom: "t1", direction: "down" } });
    // No split source: falls back to a tab.
    expect(createPayload(draft({ placement: "split" }), null, false)).toMatchObject({ payload: { placement: "tab" } });
  });

  it("a destructive mode needs the confirmation and then carries confirmBypass", () => {
    expect(createPayload(draft({ permissionMode: "bypassPermissions" }), null, false)).toMatchObject({ ok: false });
    expect(createPayload(draft({ permissionMode: "bypassPermissions" }), null, true)).toMatchObject({
      ok: true,
      payload: { permissionMode: "bypassPermissions", confirmBypass: true },
    });
    expect(createPayload(draft({ permissionMode: "plan" }), null, true)).not.toHaveProperty("payload.confirmBypass");
  });

  it("a plain shell takes no launch options", () => {
    const out = createPayload(draft({ harness: PLAIN_SHELL_ID, model: "haiku" }), null, false);
    expect(out).toEqual({ ok: true, payload: { projectId: "w1", harness: PLAIN_SHELL_ID, placement: "tab" } });
  });

  it("refuses with a reason when the draft is not ready", () => {
    expect(createPayload(draft({ projectId: null }), null, false)).toMatchObject({ ok: false, reason: "Pick a project." });
    expect(createPayload(draft({ harness: null }), null, false)).toMatchObject({ ok: false });
    expect(createPayload(draft({ model: "--x" }), null, false)).toMatchObject({ ok: false });
  });
});

describe("split source", () => {
  it("only an open, live thread in the chosen project", () => {
    expect(splitSource(null, "w1")).toBeNull();
    expect(splitSource(thread("t1"), "w2")).toBeNull();
    expect(splitSource(thread("t1", { shelf: "archived" }), "w1")).toBeNull();
    expect(splitSource(thread("t1"), "w1")?.id).toBe("t1");
  });
});

describe("projects", () => {
  it("lists open projects with worktrees under their primary and live thread counts", () => {
    const projects = [
      project("w1", { label: "sightr", number: 1, order: 0, repoKey: "r" }),
      project("w2", { label: "other", number: 2, order: 1 }),
      project("w3", { label: "sightr-wt", number: 3, order: 2, repoKey: "r", worktreeOf: "r" }),
      project("w4", { label: "closed", number: 4, order: 3, closedAt: 5 }),
    ];
    const threads = [thread("a", { projectId: "w1" }), thread("b", { projectId: "w1", shelf: "archived" }), thread("c", { projectId: "w2" })];
    const entries = projectEntries(projects, threads);
    expect(entries.map((e) => [e.project.id, e.threadCount, e.nested])).toEqual([
      ["w1", 1, false],
      ["w3", 0, true],
      ["w2", 1, false],
    ]);
    expect(searchProjects(entries, "OTH").map((e) => e.project.id)).toEqual(["w2"]);
    expect(searchProjects(entries, "3").map((e) => e.project.id)).toEqual(["w3"]);
  });
});

describe("progress and words", () => {
  it("the phase comes from the thread's own state", () => {
    expect(phaseForThread(undefined)).toBeNull();
    expect(phaseForThread(thread("t", { status: "starting" }))).toBe("starting");
    expect(phaseForThread(thread("t", { status: "idle" }))).toBe("ready");
    expect(phaseForThread(thread("t", { status: "working" }))).toBe("ready");
    expect(phaseForThread(thread("t", { status: "failed" }))).toBe("failed");
    expect(phaseForThread(thread("t", { shelf: "archived", archiveReason: "spawn-failed" }))).toBe("failed");
  });

  it("names the tab from the first words of the message", () => {
    expect(nameFromMessage("  fix the login\nbug on the phone please ")).toBe("fix the login bug on");
    expect(nameFromMessage("")).toBe("");
    expect(nameFromMessage("x".repeat(60)).length).toBe(40);
  });

  it("puts the bridge's refusals in the operator's words", () => {
    expect(startRefusalText("bad-cwd", "x")).toBe("That folder does not exist on the host.");
    expect(startRefusalText("invalid-launch: bad-model", "x")).toMatch(/bad-model/);
    expect(startRefusalText(undefined, "Could not reach the bridge.")).toBe("Could not reach the bridge.");
  });
});
