import { describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractGrokUserSpeech,
  foldGrokHint,
  grokHintHasQuery,
  grokJournal,
  GrokTranscriptSource,
  isGrokSessionId,
  lastGrokUserQueries,
  liveGrokPrompt,
  parseGrokTranscript,
  scoreGrokHint,
  truncatedTitlePrefixes,
} from "./grok.ts";

const SID = "01a00e2f-d3f3-7290-bc3d-fd276f91e272";
const OLDER = "703814f0-cd28-5e23-b5c6-869df1969c41";

const userQuery = (text: string, index = 0) =>
  JSON.stringify({
    type: "user",
    content: [{ type: "text", text: `<user_query>\n${text}\n</user_query>` }],
    prompt_index: index,
  });

const assistant = (text: string, toolCalls?: unknown[]) =>
  JSON.stringify({
    type: "assistant",
    content: text,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
  });

describe("isGrokSessionId", () => {
  test.each([
    ["a v7-shaped id", SID, true],
    ["a v4 uuid", OLDER, true],
    ["a traversal attempt", "../../secrets", false],
    ["chat_history.jsonl", "chat_history.jsonl", false],
  ])("%s → %s", (_label, value, expected) => {
    expect(isGrokSessionId(value)).toBe(expected);
  });
});

describe("extractGrokUserSpeech", () => {
  test("unwraps <user_query>", () => {
    expect(extractGrokUserSpeech("<user_query>\nmerge\n</user_query>")).toBe("merge");
  });

  test.each([
    ["the injected workspace blob", "<user_info>\nOS Version: windows\n</user_info>"],
    ["a system reminder", "<system-reminder>\nskills…\n</system-reminder>"],
    ["empty", ""],
  ])("drops %s", (_label, raw) => {
    expect(extractGrokUserSpeech(raw)).toBeNull();
  });

  test("keeps a bare spoken line (no envelope)", () => {
    expect(extractGrokUserSpeech("just this")).toBe("just this");
  });

  test("pulls <user_query> out of the first-row workspace blob", () => {
    expect(
      extractGrokUserSpeech(
        "<user_info>\nOS Version: windows\n</user_info>\n<user_query>\nmerge, rebuild\n</user_query>",
      ),
    ).toBe("merge, rebuild");
  });
});

describe("parseGrokTranscript", () => {
  test("reads spoken turns and drops system / reminder / reasoning rows", () => {
    const text = [
      JSON.stringify({ type: "system", content: "You are Grok." }),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "<user_info>\nOS Version: windows\n</user_info>" }],
      }),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "<system-reminder>\nskills\n</system-reminder>" }],
        synthetic_reason: "system_reminder",
      }),
      userQuery("how do I scroll?"),
      JSON.stringify({
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "thinking…" }],
      }),
      assistant("Swipe up."),
    ].join("\n");
    const entries = parseGrokTranscript(text);
    expect(entries.map((e) => [e.role, e.parts[0] && "text" in e.parts[0] ? e.parts[0].text : ""])).toEqual([
      ["user", "how do I scroll?"],
      ["assistant", "Swipe up."],
    ]);
  });

  test("folds a tool_result onto the matching call", () => {
    const text = [
      assistant("Looking.", [
        { id: "call-1", name: "read_file", arguments: JSON.stringify({ target_file: "/repo/README.md" }) },
      ]),
      JSON.stringify({ type: "tool_result", tool_call_id: "call-1", content: "# Sightr\nA phone UI." }),
    ].join("\n");
    const entries = parseGrokTranscript(text);
    expect(entries).toHaveLength(1);
    const tool = entries[0]!.parts.find((p) => p.kind === "tool");
    expect(tool).toMatchObject({
      kind: "tool",
      name: "read_file",
      summary: "/repo/README.md",
      result: { text: "# Sightr\nA phone UI." },
    });
  });

  test("skips a clipped last line rather than throwing", () => {
    expect(parseGrokTranscript(['{"type":"assi', userQuery("hi")].join("\n"))).toHaveLength(1);
  });

  test("gives each turn a stable unique cursor", () => {
    const text = [userQuery("one"), userQuery("two"), assistant("ok")].join("\n");
    const entries = parseGrokTranscript(text);
    const ids = entries.map((e) => e.uuid);
    expect(new Set(ids).size).toBe(ids.length);
    expect(parseGrokTranscript(text).map((e) => e.uuid)).toEqual(ids);
  });

  test("keeps an interjection follow-up as a user turn", () => {
    const text = [
      userQuery("first"),
      assistant("working"),
      JSON.stringify({
        type: "user",
        synthetic_reason: "interjection",
        content: [{ type: "text", text: "<user_query>\nalso, the first turn is missing\n</user_query>" }],
      }),
    ].join("\n");
    const entries = parseGrokTranscript(text);
    expect(entries.map((e) => [e.role, e.parts[0] && "text" in e.parts[0] ? e.parts[0].text : ""])).toEqual([
      ["user", "first"],
      ["assistant", "working"],
      ["user", "also, the first turn is missing"],
    ]);
  });
});

describe("GrokTranscriptSource", () => {
  async function fixture() {
    const created = `${tmpdir()}/sightr-grok-${Math.floor(performance.now() * 1000)}`;
    await mkdir(created, { recursive: true });
    const base = await realpath(created);
    const root = join(base, "sessions");
    const cwd = "C:\\Work-Dir";
    const cwdDir = join(root, encodeURIComponent(cwd));
    const sessionDir = join(cwdDir, SID);
    await mkdir(sessionDir, { recursive: true });
    const log = join(sessionDir, "chat_history.jsonl");
    await Bun.write(log, userQuery("hi"));
    const olderDir = join(cwdDir, OLDER);
    await mkdir(olderDir, { recursive: true });
    const olderLog = join(olderDir, "chat_history.jsonl");
    await Bun.write(olderLog, userQuery("older"));
    // Make SID newer so inferFromCwd picks the live session.
    await Bun.write(log, userQuery("hi") + "\n" + assistant("yo"));
    // Stamped explicitly: on a fast disk both writes can land in the same millisecond, and a tie on
    // mtime would leave readdir order to decide which session is "newest".
    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-01-01T00:01:00Z");
    await utimes(olderLog, older, older);
    await utimes(log, newer, newer);
    return { base, root, cwd, log };
  }

  test("resolves an id by scanning per-cwd directories", async () => {
    const { base, root, log } = await fixture();
    expect(await new GrokTranscriptSource(root).resolve({ kind: "id", value: SID })).toBe(log);
    await rm(base, { recursive: true, force: true });
  });

  test("an unknown id resolves to null rather than guessing", async () => {
    const { base, root } = await fixture();
    expect(
      await new GrokTranscriptSource(root).resolve({
        kind: "id",
        value: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      }),
    ).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("refuses a traversal id", async () => {
    const { base, root } = await fixture();
    expect(await new GrokTranscriptSource(root).resolve({ kind: "id", value: "../../secrets" })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("inferFromCwd returns the newest session under that cwd", async () => {
    const { base, root, cwd } = await fixture();
    expect(await new GrokTranscriptSource(root).inferFromCwd(cwd)).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });

  test("inferFromCwd matches a cwd whose separators or case differ", async () => {
    const { base, root } = await fixture();
    expect(await new GrokTranscriptSource(root).inferFromCwd("c:/work-dir")).toEqual({
      kind: "id",
      value: SID,
    });
    await rm(base, { recursive: true, force: true });
  });

  test("grokJournal.inferFromCwd is wired through the adapter", async () => {
    const { base, root, cwd } = await fixture();
    const adapter = grokJournal(root);
    expect(adapter.agent).toBe("grok");
    expect(await adapter.inferFromCwd?.(cwd)).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });
});

describe("scoreGrokHint / lastGrokUserQueries", () => {
  test("unwraps the last spoken user turns, newest first", () => {
    const text = [
      userQuery("first question goes here"),
      assistant("ok"),
      userQuery("second question goes here"),
    ].join("\n");
    expect(lastGrokUserQueries(text, 2)).toEqual([
      "second question goes here",
      "first question goes here",
    ]);
  });

  test("scores a viewport that contains this session's last user turn", () => {
    const hint = foldGrokHint(
      "     > review the geneanalysis project in detail                                  3:01 PM",
    );
    expect(
      scoreGrokHint(hint, null, ["review the geneanalysis project in detail"]),
    ).toBeGreaterThan(0);
    expect(scoreGrokHint(hint, null, ["sightr scrollable history from other tabs"])).toBe(0);
  });

  test("scores a generated title that appears in the hint", () => {
    expect(scoreGrokHint(foldGrokHint("Sightr history leak"), "Sightr history leak", [])).toBeGreaterThan(
      1000,
    );
  });

  test("scores an OSC-truncated title as a prefix of the generated title", () => {
    const hint = foldGrokHint("Sightr incorrect history with multiple … - grok");
    expect(truncatedTitlePrefixes(hint)).toEqual(["sightr incorrect history with multiple"]);
    expect(
      scoreGrokHint(hint, "Sightr incorrect history with multiple panes", []),
    ).toBeGreaterThan(1000);
    expect(scoreGrokHint(hint, "Firelight session 5 careful-mode ADW", [])).toBe(0);
  });

  test("scores a working-pane title that sandwiches the session title between ellipses", () => {
    const hint = foldGrokHint(
      "Find schema dump and list live agents… - Sightr incorrect history with multiple … - grok",
    );
    expect(
      scoreGrokHint(hint, "Sightr incorrect history with multiple panes", []),
    ).toBeGreaterThan(1000);
  });

  test("grokHintHasQuery matches a full turn and a long-query prefix", () => {
    const hint = foldGrokHint(
      "     > software factory anything outstanding?                                  3:31 PM",
    );
    expect(grokHintHasQuery(hint, "software factory anything outstanding?")).toBe(true);
    expect(grokHintHasQuery(hint, "update docs for next session")).toBe(false);
    const long =
      "make sure the pane details context row works for pi too when the composer is locked";
    expect(grokHintHasQuery(foldGrokHint(long.slice(0, 80)), long)).toBe(true);
  });

  test("liveGrokPrompt reads a clipped > line and grokHintHasQuery accepts it as a prefix", () => {
    const raw = [
      "Consolidate Grok tool calls to match Claude… - grok",
      "C:\\work-dir  115K / 500K",
      "     > merge, rebuild, restart, update docs for next se",
      "     ♦ Thinking...",
    ].join("\n");
    const prompt = liveGrokPrompt(raw);
    expect(prompt).toBe("merge, rebuild, restart, update docs for next se");
    expect(
      grokHintHasQuery(
        foldGrokHint(raw),
        "merge, rebuild, restart, update docs for next session",
        prompt,
      ),
    ).toBe(true);
    expect(grokHintHasQuery(foldGrokHint(raw), "merge, rebuild, restart, update docs for next session")).toBe(
      false,
    );
  });

  test("a title match still outscores a query match — pickByHint is what prefers the query", () => {
    const hint = foldGrokHint(
      "Typed review findings and factory trace hygiene… - grok\n> software factory anything outstanding?  3:31 PM",
    );
    const titleScore = scoreGrokHint(hint, "Typed review findings and factory trace hygiene", []);
    const queryScore = scoreGrokHint(hint, null, ["software factory anything outstanding?"]);
    expect(titleScore).toBeGreaterThan(1000);
    expect(queryScore).toBeGreaterThan(0);
    expect(titleScore).toBeGreaterThan(queryScore);
  });
});

describe("GrokTranscriptSource — several panes, one cwd", () => {
  const NL = String.fromCharCode(10);
  const OLDER_Q = "review the geneanalysis project in detail";
  const NEWER_Q = "sightr scrollable history shows history from other tabs";

  async function twoPanes() {
    const created = `${tmpdir()}/sightr-grok-${Math.floor(performance.now() * 1000)}`;
    await mkdir(created, { recursive: true });
    const base = await realpath(created);
    const root = join(base, "sessions");
    const cwd = "C:\\Work-Dir";
    const cwdDir = join(root, encodeURIComponent(cwd));
    await mkdir(join(cwdDir, SID), { recursive: true });
    await mkdir(join(cwdDir, OLDER), { recursive: true });
    const newerLog = join(cwdDir, SID, "chat_history.jsonl");
    const olderLog = join(cwdDir, OLDER, "chat_history.jsonl");
    await Bun.write(olderLog, userQuery(OLDER_Q));
    await Bun.write(newerLog, userQuery(NEWER_Q));
    await Bun.write(join(cwdDir, OLDER, "summary.json"), JSON.stringify({ generated_title: "Geneanalysis review" }));
    await Bun.write(join(cwdDir, SID, "summary.json"), JSON.stringify({ generated_title: "Sightr history leak" }));
    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-01-01T00:01:00Z");
    await utimes(olderLog, older, older);
    await utimes(newerLog, newer, newer);
    return { base, root, cwd };
  }

  test("shared cwd + hint picks the matching session, not the newest", async () => {
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    const hint = `     > ${OLDER_Q}                                  3:01 PM`;
    expect(
      await src.inferFromCwd({ cwd, paneId: "w1:p1", hint }),
    ).toEqual({ kind: "id", value: OLDER });
    expect(
      await src.inferFromCwd({ cwd, paneId: "w1:p2", hint: `     > ${NEWER_Q}                                  3:02 PM` }),
    ).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });

  test("a pane with no evidence gets a session rather than a blank history", async () => {
    // A cleared pane on a cold bridge: no hint, no remembered claim. It used to get nothing at all.
    const { base, root, cwd } = await twoPanes();
    expect(await new GrokTranscriptSource(root).inferFromCwd({ cwd, paneId: "w1:p1" })).toEqual({
      kind: "id",
      value: SID,
    });
    await rm(base, { recursive: true, force: true });
  });

  test("two panes with no evidence get different sessions, never the same one", async () => {
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    const first = await src.inferFromCwd({ cwd, paneId: "w1:p1" });
    const second = await src.inferFromCwd({ cwd, paneId: "w1:p2" });
    expect(first).toEqual({ kind: "id", value: SID });
    expect(second).toEqual({ kind: "id", value: OLDER });
    await rm(base, { recursive: true, force: true });
  });

  test("evidence corrects a guess, and takes the log back off the pane that guessed it", async () => {
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    // p1 guesses the newest log with nothing to go on.
    expect(await src.inferFromCwd({ cwd, paneId: "w1:p1" })).toEqual({ kind: "id", value: SID });
    // p2 then proves the newest log is actually its own.
    expect(await src.inferFromCwd({ cwd, paneId: "w1:p2", hint: `> ${NEWER_Q}` })).toEqual({
      kind: "id",
      value: SID,
    });
    // p1 must move off it rather than keep serving p2's conversation.
    expect(await src.inferFromCwd({ cwd, paneId: "w1:p1" })).toEqual({ kind: "id", value: OLDER });
    await rm(base, { recursive: true, force: true });
  });

  test("a guess never displaces a pane identified from its own screen", async () => {
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    await src.inferFromCwd({ cwd, paneId: "w1:p1", hint: `> ${NEWER_Q}` });
    // p2 has nothing to go on. It must take the other log, not steal p1's proven one.
    expect(await src.inferFromCwd({ cwd, paneId: "w1:p2" })).toEqual({ kind: "id", value: OLDER });
    expect(await src.inferFromCwd({ cwd, paneId: "w1:p1" })).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });

  test("a pane waiting on a reply is not handed the neighbour's newer log", async () => {
    // Observed live: a pane titled "Organize CT docs" was serving the "Firelight extensibility"
    // conversation, because it showed a prompt no log contained yet and the neighbour's session
    // happened to be the most recently written one at that cwd.
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    // The neighbour proves the newest log is its own.
    expect(await src.inferFromCwd({ cwd, paneId: "w1:p1", hint: `> ${NEWER_Q}` })).toEqual({
      kind: "id",
      value: SID,
    });
    // This pane is mid-turn: a prompt on screen that is in no log, plus its own title.
    const hint = "Geneanalysis review… - grok" + NL + "     > waiting on a reply right now";
    expect(await src.inferFromCwd({ cwd, paneId: "w1:p2", hint })).toEqual({
      kind: "id",
      value: OLDER,
    });
    await rm(base, { recursive: true, force: true });
  });

  test("a stale reported session loses to what the pane is showing", async () => {
    // Herdr's grok integration names the session a pane STARTED with. When the operator opens a
    // new session in that pane it keeps naming the old one, so it must not beat the screen.
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    expect(
      await src.inferFromCwd({
        cwd,
        paneId: "w1:p1",
        hint: `> ${NEWER_Q}`,
        reportedSessionId: OLDER,
      }),
    ).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });

  test("a stale reported session cannot undo a proven claim once the pane goes quiet", async () => {
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    await src.inferFromCwd({ cwd, paneId: "w1:p1", hint: `> ${NEWER_Q}` });
    // Screen now blank. The stale id must not drag the pane back to the previous conversation.
    expect(
      await src.inferFromCwd({ cwd, paneId: "w1:p1", reportedSessionId: OLDER }),
    ).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });

  test("a reported session is used when the pane shows nothing and nothing is claimed", async () => {
    // Better than a positional guess: prefer what Herdr says over "the newest one".
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    expect(
      await src.inferFromCwd({ cwd, paneId: "w1:p1", reportedSessionId: OLDER }),
    ).toEqual({ kind: "id", value: OLDER });
    await rm(base, { recursive: true, force: true });
  });

  test("a reported session that is not a candidate here is ignored", async () => {
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    expect(
      await src.inferFromCwd({
        cwd,
        paneId: "w1:p1",
        reportedSessionId: "01a00e2f-dead-7290-bc3d-fd276f91e273",
      }),
    ).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });

  test("a cleared pane keeps its history across a bridge restart", async () => {
    // The failure this whole mechanism exists for: the pane is showing nothing, the process that
    // did the matching is gone, and the operator still expects their conversation.
    const { base, root, cwd } = await twoPanes();
    const claimFile = join(base, "pane-claims.json");
    const before = new GrokTranscriptSource(root, claimFile);
    await before.inferFromCwd({ cwd, paneId: "w1:p1", hint: `> ${OLDER_Q}` });
    await before.inferFromCwd({ cwd, paneId: "w1:p2", hint: `> ${NEWER_Q}` });
    await before.flushClaims();

    const after = new GrokTranscriptSource(root, claimFile);
    expect(await after.inferFromCwd({ cwd, paneId: "w1:p1" })).toEqual({ kind: "id", value: OLDER });
    expect(await after.inferFromCwd({ cwd, paneId: "w1:p2" })).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });

  test("a claim is released when the pane stops running grok at this cwd", async () => {
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    await src.inferFromCwd({ cwd, paneId: "w1:p1", hint: `> ${NEWER_Q}` });
    // p1 is gone; only p2 is left, so the log p1 held must become available again.
    expect(
      await src.inferFromCwd({ cwd, paneId: "w1:p2", peerPaneIds: ["w1:p2"] }),
    ).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });

  test("a later poll without a hint reuses the pane's bound session", async () => {
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    await src.inferFromCwd({ cwd, paneId: "w1:p1", hint: `> ${OLDER_Q}` });
    expect(await src.inferFromCwd({ cwd, paneId: "w1:p1" })).toEqual({
      kind: "id",
      value: OLDER,
    });
    await rm(base, { recursive: true, force: true });
  });

  test("a unique hint can steal a session previously bound to another pane", async () => {
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    await src.inferFromCwd({ cwd, paneId: "w1:p1", hint: `> ${NEWER_Q}` });
    expect(
      await src.inferFromCwd({ cwd, paneId: "w1:p2", hint: `> ${NEWER_Q}` }),
    ).toEqual({ kind: "id", value: SID });
    // p1's claim was taken; without a hint it must move to the other log, not keep serving p2's.
    expect(await src.inferFromCwd({ cwd, paneId: "w1:p1" })).toEqual({ kind: "id", value: OLDER });
    await rm(base, { recursive: true, force: true });
  });

  test("a truncated title binds the matching session even when the route missed the sibling", async () => {
    const { base, root, cwd } = await twoPanes();
    const cwdDir = join(root, encodeURIComponent(cwd));
    await Bun.write(
      join(cwdDir, OLDER, "summary.json"),
      JSON.stringify({ generated_title: "Sightr incorrect history with multiple panes" }),
    );
    const src = new GrokTranscriptSource(root);
    expect(
      await src.inferFromCwd({
        cwd,
        paneId: "w1:p1",
        hint: "Sightr incorrect history with multiple … - grok",
      }),
    ).toEqual({ kind: "id", value: OLDER });
    await rm(base, { recursive: true, force: true });
  });

  test("a newer subagent session is not bound as this pane's history", async () => {
    const { base, root, cwd } = await twoPanes();
    const cwdDir = join(root, encodeURIComponent(cwd));
    const sub = "01a00e2f-d3f3-7290-bc3d-fd276f91e273";
    await mkdir(join(cwdDir, sub), { recursive: true });
    const subLog = join(cwdDir, sub, "chat_history.jsonl");
    await Bun.write(subLog, userQuery("explore the sightr pane history bug in detail"));
    await Bun.write(
      join(cwdDir, sub, "summary.json"),
      JSON.stringify({
        generated_title: "Sightr pane-group history sharing bug",
        session_kind: "subagent",
      }),
    );
    const newest = new Date("2026-01-01T00:02:00Z");
    await utimes(subLog, newest, newest);
    const src = new GrokTranscriptSource(root);
    expect(
      await src.inferFromCwd({
        cwd,
        paneId: "w1:p2",
        hint: "Sightr history leak… - grok",
      }),
    ).toEqual({ kind: "id", value: SID });
    // A pane with nothing to go on must not be handed the subagent log either, even though it is
    // the newest thing in the folder. A fresh source, so no claim from the assertion above stands.
    expect(await new GrokTranscriptSource(root).inferFromCwd({ cwd, paneId: "w1:p3" })).toEqual({
      kind: "id",
      value: SID,
    });
    await rm(base, { recursive: true, force: true });
  });

  test("a live user query beats a stale OSC title from the pane's previous session", async () => {
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    const hint = [
      "Geneanalysis review… - grok",
      `     > ${NEWER_Q}                                  3:02 PM`,
    ].join("\n");
    expect(
      await src.inferFromCwd({ cwd, paneId: "w1:p2", hint }),
    ).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });

  test("session rollover: stale OSC title does not keep the previous jsonl", async () => {
    // Live Sf pane 2026-09-07: TUI was the new leftover-work session, journal stayed on
    // "Typed review findings…" because OSC title scoring (1000+) beat the live `> query`.
    const { base, root, cwd } = await twoPanes();
    const cwdDir = join(root, encodeURIComponent(cwd));
    await Bun.write(join(cwdDir, OLDER, "chat_history.jsonl"), userQuery("update docs for next session"));
    await Bun.write(
      join(cwdDir, OLDER, "summary.json"),
      JSON.stringify({ generated_title: "Typed review findings and factory trace hygiene" }),
    );
    await Bun.write(
      join(cwdDir, SID, "chat_history.jsonl"),
      userQuery("software factory anything outstanding?"),
    );
    await Bun.write(
      join(cwdDir, SID, "summary.json"),
      JSON.stringify({ generated_title: "Software Factory Outstanding Items Inquiry" }),
    );
    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-01-01T00:01:00Z");
    await utimes(join(cwdDir, OLDER, "chat_history.jsonl"), older, older);
    await utimes(join(cwdDir, SID, "chat_history.jsonl"), newer, newer);
    const src = new GrokTranscriptSource(root);
    const hint = [
      "Typed review findings and factory trace hygiene… - grok",
      "C:\\work-dir                    48K / 500K",
      "     > software factory anything outstanding?                                  3:31 PM",
    ].join("\n");
    expect(
      await src.inferFromCwd({ cwd, paneId: "w1:sf", hint }),
    ).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });

  test("a later poll with a new live query rebinds a pane stuck on the previous session", async () => {
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    expect(
      await src.inferFromCwd({
        cwd,
        paneId: "w1:p1",
        hint: `> ${OLDER_Q}`,
      }),
    ).toEqual({ kind: "id", value: OLDER });
    expect(
      await src.inferFromCwd({
        cwd,
        paneId: "w1:p1",
        hint: ["Geneanalysis review… - grok", `> ${NEWER_Q}`].join("\n"),
      }),
    ).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });

  test("two panes after rollover each bind their live query, not the sibling's stale title", async () => {
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    expect(
      await src.inferFromCwd({
        cwd,
        paneId: "w1:p1",
        hint: ["Sightr history leak… - grok", `> ${OLDER_Q}`].join("\n"),
      }),
    ).toEqual({ kind: "id", value: OLDER });
    expect(
      await src.inferFromCwd({
        cwd,
        paneId: "w1:p2",
        hint: ["Geneanalysis review… - grok", `> ${NEWER_Q}`].join("\n"),
      }),
    ).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });

  test("a title-only hint still binds when no live user query is on screen", async () => {
    const { base, root, cwd } = await twoPanes();
    const src = new GrokTranscriptSource(root);
    expect(
      await src.inferFromCwd({
        cwd,
        paneId: "w1:p1",
        hint: "Geneanalysis review… - grok",
      }),
    ).toEqual({ kind: "id", value: OLDER });
    await rm(base, { recursive: true, force: true });
  });

  test("a clipped live > query still beats a stale OSC title", async () => {
    const { base, root, cwd } = await twoPanes();
    const cwdDir = join(root, encodeURIComponent(cwd));
    const q = "merge, rebuild, restart, update docs for next session";
    await Bun.write(join(cwdDir, SID, "chat_history.jsonl"), userQuery(q));
    await Bun.write(
      join(cwdDir, SID, "summary.json"),
      JSON.stringify({ generated_title: "Consolidate Grok tool calls to match Claude" }),
    );
    await Bun.write(
      join(cwdDir, OLDER, "summary.json"),
      JSON.stringify({ generated_title: "Thinking display shipped" }),
    );
    const src = new GrokTranscriptSource(root);
    const hint = [
      "Thinking display shipped… - grok",
      "     > merge, rebuild, restart, update docs for next se",
    ].join("\n");
    expect(
      await src.inferFromCwd({ cwd, paneId: "w1:p2", hint }),
    ).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });

  test("a live > query no jsonl has yet binds newest, not the stale title", async () => {
    const { base, root, cwd } = await twoPanes();
    const cwdDir = join(root, encodeURIComponent(cwd));
    await Bun.write(
      join(cwdDir, OLDER, "summary.json"),
      JSON.stringify({ generated_title: "Thinking display shipped" }),
    );
    await Bun.write(
      join(cwdDir, SID, "chat_history.jsonl"),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "<user_info>\nOS Version: windows\n</user_info>" }],
      }),
    );
    const src = new GrokTranscriptSource(root);
    const hint = [
      "Thinking display shipped… - grok",
      "     > grok tool calls in sightr are not consolidat",
    ].join("\n");
    expect(
      await src.inferFromCwd({ cwd, paneId: "w1:p2", hint }),
    ).toEqual({ kind: "id", value: SID });
    await rm(base, { recursive: true, force: true });
  });
});
