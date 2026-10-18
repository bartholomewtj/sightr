import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { RuntimeRequest } from "../../shared/v2/contracts.ts";
import { AuditLog } from "../audit.ts";
import type { Config } from "../config.ts";
import type { HerdrClient, PaneRead } from "../herdr-client.ts";
import { createPaneQueue } from "../pane-queue.ts";
import type { AgentView, EngineSnapshot } from "../state-engine.ts";
import { createProject, createThread, project, thread } from "../test/thread-fixtures.ts";
import { createRequestIngestor, type RequestIngestor } from "./request-ingest.ts";
import { requestItemId } from "./request-items.ts";
import { openThreadStore, type ThreadStore } from "./store.ts";

// `runtime-request.respond` with `text` (free-text.ts): the operator's own answer typed into the
// dialog's "Type something." row. The screens are live herdr reads (2026-10-18), and the fake pane
// moves between them the way the harness did when the same keys were sent by hand.

const LIVE = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "live-free-text");
const PANES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const live = (name: string) => readFileSync(join(LIVE, name), "utf8");

/** Claude: the fresh ask, the row focused (empty), the row holding `typed`. */
const CLAUDE_FRESH = live("claude--ask-free-text-live.txt");
const CLAUDE_TYPED = live("claude--ask-free-text-typed.txt");
const claudeTyped = (typed: string) => CLAUDE_TYPED.replace("my own answer C", typed);
const CLAUDE_FOCUSED = claudeTyped("Type something.");
/** Pi: the fresh one-question ask, its editor open (empty), the editor holding `typed`. */
const PI_FRESH = live("pi--ask-radio-live.txt");
const PI_OPEN = live("pi--ask-radio-editing.txt");
const piTyped = (typed: string) => live("pi--ask-radio-editing-typed.txt").replace("my pi answer Z", typed);
const DONE = readFileSync(join(PANES, "claude--done.txt"), "utf8");
const PERMISSION = readFileSync(join(PANES, "claude--permission-bash.txt"), "utf8");

const T0 = 1_800_000_000_000;
const PANE = "w1:p-t1";
const cfg = { submitKeys: ["Enter"], readLines: 200, deviceAllowlist: [], notifyDelayMs: 0 } as unknown as Config;

/** A pane whose screen follows a script of key and text writes. */
class ScriptedPane {
  log: string[] = [];
  constructor(
    public screen: string,
    public onKey: (key: string, pane: ScriptedPane) => void = () => {},
    public onText: (text: string, pane: ScriptedPane) => void = () => {},
  ) {}
  async readPane(paneId: string): Promise<PaneRead> {
    return { pane_id: paneId, text: this.screen, truncated: false, revision: 0 };
  }
  async sendPaneKeys(_paneId: string, keys: string[]): Promise<void> {
    for (const k of keys) {
      this.log.push(`key:${k}`);
      this.onKey(k, this);
    }
  }
  async sendPaneText(_paneId: string, text: string): Promise<void> {
    this.log.push(`text:${text}`);
    this.onText(text, this);
  }
}

const stores: ThreadStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function rig(pane: ScriptedPane, agent = "claude") {
  let n = 0;
  const store = openThreadStore(":memory:", { now: () => T0, newId: () => `id${++n}` });
  stores.push(store);
  store.append([
    createProject(project()),
    createThread(thread("t1", { paneId: PANE, terminalId: "term-t1", harness: agent, status: "input" })),
  ]);
  const view: AgentView = {
    paneId: PANE,
    terminalId: "term-t1",
    workspaceId: "w1",
    workspaceLabel: "demo",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent,
    status: "blocked",
    cwd: "C:\\code\\demo",
    focused: false,
    kind: "agent",
  };
  const snap = (): EngineSnapshot => ({ agents: [view], shellPanes: [], workspaces: [], tabs: [], bridge: "connected" });
  const audit: string[] = [];
  const ingestor: RequestIngestor = createRequestIngestor({
    store,
    engine: { current: snap, onUpdate: () => () => {} },
    herdr: pane as unknown as HerdrClient,
    queue: createPaneQueue(),
    cfg,
    audit: new AuditLog((line) => void audit.push(line)),
    now: () => T0,
    newId: () => `id${++n}`,
    log: () => {},
    sleep: async () => {},
  });
  const pending = (): RuntimeRequest => {
    const [request] = store.pendingRequests();
    if (!request) throw new Error("no pending request");
    return request;
  };
  return { store, ingestor, audit, pending };
}

/** Claude's walk: the row's digit focuses it, typing fills it, Enter answers and the ask closes. */
function claudePane(opts: { digitDoes?: string; textShows?: (t: string) => string } = {}) {
  return new ScriptedPane(
    CLAUDE_FRESH,
    (key, p) => {
      if (key === "3") p.screen = opts.digitDoes ?? CLAUDE_FOCUSED;
      else if (key === "Enter") p.screen = DONE;
    },
    (text, p) => {
      p.screen = (opts.textShows ?? claudeTyped)(text);
    },
  );
}

describe("free-text answer — Claude AskUserQuestion", () => {
  test("the question is freeText, its item allows a custom answer, and `text` types it in: digit, text, Enter", async () => {
    const pane = claudePane();
    const r = rig(pane);
    await r.ingestor.poll();
    const request = r.pending();
    expect(request.freeText).toBe(true);
    expect(request.options.map((o) => o.label)).toEqual(["A", "B", "Chat about this"]);
    const item = r.store.getTurnItem(requestItemId(request.id));
    expect(item?.type === "user_input_request" && item.questions[0]?.allowCustomAnswer).toBe(true);

    const result = await r.ingestor.respond({ requestId: request.id, text: "  my own\nanswer C " }, { commandId: "c1" });
    expect(result.ok).toBe(true);
    expect(pane.log).toEqual(["key:3", "text:my own answer C", "key:Enter"]);
    expect(r.store.getRequest(request.id)).toMatchObject({ status: "resolved", customAnswer: "my own answer C" });
    expect(r.store.receipt("c1")).toMatchObject({ type: "runtime-request.respond" });
    expect(r.audit.at(-1)).toContain('"recipe":"free-text"');

    // Idempotent: the same answer again finds nothing pending and types nothing.
    const again = await r.ingestor.respond({ requestId: request.id, text: "my own answer C" }, { commandId: "c1" });
    expect(again).toMatchObject({ ok: false, code: "conflict" });
    expect(pane.log).toHaveLength(3);
  });

  test("a row already focused (empty) is typed into without its digit", async () => {
    const pane = claudePane();
    pane.screen = CLAUDE_FOCUSED;
    const r = rig(pane);
    await r.ingestor.poll();
    const request = r.pending();
    expect(request.freeText).toBe(true);
    expect(request.options).toEqual([]); // digits would be typed into the row
    expect((await r.ingestor.respond({ requestId: request.id, text: "hi" })).ok).toBe(true);
    expect(pane.log).toEqual(["text:hi", "key:Enter"]);
  });

  test("a row that already holds someone's text is not freeText, and `text` is refused", async () => {
    const pane = claudePane();
    pane.screen = CLAUDE_TYPED;
    const r = rig(pane);
    await r.ingestor.poll();
    const request = r.pending();
    expect(request.freeText).toBeUndefined();
    expect(await r.ingestor.respond({ requestId: request.id, text: "mine" })).toMatchObject({ ok: false, code: "invalid", reason: "no-free-text" });
    expect(pane.log).toEqual([]);
  });

  test("bad commands type nothing: a permission, both answers, an empty text", async () => {
    const perm = new ScriptedPane(PERMISSION);
    const p = rig(perm);
    await p.ingestor.poll();
    expect(await p.ingestor.respond({ requestId: p.pending().id, text: "yes" })).toMatchObject({ code: "invalid", reason: "no-free-text" });

    const pane = claudePane();
    const r = rig(pane);
    await r.ingestor.poll();
    const id = r.pending().id;
    expect(await r.ingestor.respond({ requestId: id, text: "x", optionIndex: 0 })).toMatchObject({ code: "invalid", reason: "both-answers" });
    expect(await r.ingestor.respond({ requestId: id, text: " \n\u001b " })).toMatchObject({ code: "invalid", reason: "empty-text" });
    expect([...perm.log, ...pane.log]).toEqual([]);
  });

  test("the digit leads somewhere else: nothing is typed and the request expires", async () => {
    const pane = claudePane({ digitDoes: DONE });
    const r = rig(pane);
    await r.ingestor.poll();
    const id = r.pending().id;
    expect(await r.ingestor.respond({ requestId: id, text: "hello" })).toMatchObject({ ok: false, code: "prompt-changed" });
    expect(pane.log).toEqual(["key:3"]);
    expect(r.store.getRequest(id)?.status).toBe("expired");
  });

  test("the text never shows in the row: no Enter, and the operator is told it was typed", async () => {
    const pane = claudePane({ textShows: () => CLAUDE_FOCUSED });
    const r = rig(pane);
    await r.ingestor.poll();
    const id = r.pending().id;
    const result = await r.ingestor.respond({ requestId: id, text: "hello" });
    expect(result).toMatchObject({ ok: false, code: "failed" });
    expect(result.ok ? "" : result.reason).toMatch(/typed but did not show/);
    expect(pane.log).toEqual(["key:3", "text:hello"]);
    expect(r.audit.at(-1)).toContain('"textDelivered":true');
  });

  test("a long answer is capped at FREE_TEXT_MAX_CHARS before it is typed", async () => {
    const pane = claudePane();
    const r = rig(pane);
    await r.ingestor.poll();
    const long = "word ".repeat(100);
    await r.ingestor.respond({ requestId: r.pending().id, text: long });
    const typed = pane.log.find((l) => l.startsWith("text:"))!.slice(5);
    expect(typed.length).toBeLessThanOrEqual(240);
  });
});

describe("free-text answer — Pi ask", () => {
  test("arrows onto the row and Enter open the editor; then the text, then Enter", async () => {
    let downs = 0;
    const pane = new ScriptedPane(
      PI_FRESH,
      (key, p) => {
        if (key === "Down") downs++;
        else if (key === "Enter") p.screen = p.screen === PI_FRESH && downs === 2 ? PI_OPEN : DONE;
      },
      (text, p) => {
        p.screen = piTyped(text);
      },
    );
    const r = rig(pane, "pi");
    await r.ingestor.poll();
    const request = r.pending();
    expect(request.freeText).toBe(true);
    const result = await r.ingestor.respond({ requestId: request.id, text: "my pi answer" });
    expect(result.ok).toBe(true);
    expect(pane.log).toEqual(["key:Down", "key:Down", "key:Enter", "text:my pi answer", "key:Enter"]);
    expect(pane.log.some((l) => /^key:\d$/.test(l))).toBe(false); // Pi ignores digits; none are sent
    expect(r.store.getRequest(request.id)).toMatchObject({ status: "resolved", customAnswer: "my pi answer" });
  });
});
