import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AuditLog } from "./audit.ts";
import type { Config } from "./config.ts";
import { guardedSendPane, sweepKeys } from "./guarded-send-route.ts";
import type { HerdrClient } from "./herdr-client.ts";
import { createPaneQueue } from "./pane-queue.ts";
import type { StateEngine } from "./state-engine.ts";

const FIXTURES = join(import.meta.dir, "..", "web", "src", "fixtures", "panes");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const EMPTY_BOX = fixture("claude--draft-footer-empty.txt");
const PERMISSION = fixture("claude--permission-bash.txt");
// Claude's prompt row: a dim `❯`, a no-break space, then whatever is in the box.
const PROMPT_ROW = /(\x1b\[0m\x1b\[38;2;153;153;153m❯ \x1b\[0m)[^\r\n]*/;

/** A Claude pane that behaves like one: typed text lands in the box, Enter submits it. */
class FakeClaude {
  draft = "";
  dialog = false;
  /** Text typed while this is set vanishes, as into a dialog that ate it. */
  swallowText = false;
  submitted: string[] = [];
  texts: string[] = [];
  keys: string[] = [];

  screen(): string {
    return this.dialog ? PERMISSION : EMPTY_BOX.replace(PROMPT_ROW, (_m, prompt: string) => prompt + this.draft);
  }
  readPane(paneId: string) {
    return Promise.resolve({ pane_id: paneId, text: this.screen(), truncated: false, revision: 0 });
  }
  sendPaneText(_paneId: string, text: string) {
    this.texts.push(text);
    if (!this.swallowText && !this.dialog) this.draft += text;
    return Promise.resolve();
  }
  sendPaneKeys(_paneId: string, keys: string[]) {
    for (const k of keys) {
      this.keys.push(k);
      if (this.dialog) continue;
      if (k === "Enter" && this.draft) { this.submitted.push(this.draft); this.draft = ""; }
      if (k === "Backspace") this.draft = [...this.draft].slice(0, -1).join("");
    }
    return Promise.resolve();
  }
}

// Pi, from real captures. Pi takes typing as soon as its editor is drawn, but an Enter before its
// startup ends puts the text back and prints "Startup is still in progress" (the live bug: the first
// message of a new thread sat typed and unsubmitted).
const PI_MESSAGE =
  "List the files in the web2/src/components/chat folder that end in .logic.ts, then tell me which is largest. Keep it to two sentences.";
const PI_IDLE = fixture("pi--idle-empty.txt");
const PI_HELD = fixture("pi--startup-in-progress.txt");
const PI_STARTED = fixture("pi--startup-done-draft.txt");
/** The empty editor's one row: the cursor cell, then padding. */
const PI_EMPTY_ROW = /^\x1b\[0m\x1b\[7m \x1b\[0m */m;

class FakePi {
  draft = "";
  /** Reads before startup ends; each read is one tick of the clock. */
  startupReads: number;
  /** An Enter was refused, so the marker is in the chat. */
  refused = false;
  submitted: string[] = [];
  texts: string[] = [];
  keys: string[] = [];
  constructor(startupReads = 0) {
    this.startupReads = startupReads;
  }
  screen(): string {
    if (this.startupReads > 0) this.startupReads--;
    if (this.draft === "") return PI_IDLE;
    if (this.refused) return (this.startupReads > 0 ? PI_HELD : PI_STARTED).replace(PI_MESSAGE, this.draft);
    return PI_IDLE.replace(PI_EMPTY_ROW, `${this.draft}\x1b[0m\x1b[7m \x1b[0m`);
  }
  readPane(paneId: string) {
    return Promise.resolve({ pane_id: paneId, text: this.screen(), truncated: false, revision: 0 });
  }
  sendPaneText(_paneId: string, text: string) {
    this.texts.push(text);
    this.draft += text;
    return Promise.resolve();
  }
  sendPaneKeys(_paneId: string, keys: string[]) {
    for (const k of keys) {
      this.keys.push(k);
      if (k !== "Enter" || this.draft === "") continue;
      if (this.startupReads > 0) this.refused = true;
      else {
        this.submitted.push(this.draft);
        this.draft = "";
      }
    }
    return Promise.resolve();
  }
}
const PI = { paneId: "w1:p1", agent: "pi", kind: "agent" as const };

const cfg = { submitKeys: ["Enter"], readLines: 200, deviceAllowlist: [], notifyDelayMs: 0 } as unknown as Config;
const engineWith = (pane: { paneId: string; agent: string; kind?: "agent" | "shell" }) =>
  ({ current: () => ({ agents: pane.kind === "shell" ? [] : [pane], shellPanes: pane.kind === "shell" ? [pane] : [], workspaces: [], tabs: [], bridge: "connected" }) }) as unknown as StateEngine;
const CLAUDE = engineWith({ paneId: "w1:p1", agent: "claude", kind: "agent" });

function sendReq(body: unknown): Request {
  return new Request("http://127.0.0.1:8787/api/pane/w1:p1/send", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" },
    body: JSON.stringify(body),
  });
}
const noSleep = async () => {};

async function send(herdr: object, body: unknown, engine = CLAUDE, audit?: AuditLog) {
  const res = await guardedSendPane(herdr as unknown as HerdrClient, cfg, engine, "w1:p1", sendReq(body), createPaneQueue(), audit, noSleep);
  return {
    status: res.status,
    body: res.status === 200 ? ((await res.json()) as { status: string; error?: string; noEcho?: string; textDelivered?: boolean }) : await res.text(),
  };
}

describe("POST /api/pane/:id/send", () => {
  test("types, sees the text in the box, then submits", async () => {
    const claude = new FakeClaude();
    const res = await send(claude, { text: "ship the changelog" });
    expect(res.body).toEqual({ status: "sent" });
    expect(claude.texts).toEqual(["ship the changelog"]);
    expect(claude.submitted).toEqual(["ship the changelog"]);
  });

  test("a screen with no composer types nothing", async () => {
    const claude = new FakeClaude();
    claude.dialog = true;
    const res = await send(claude, { text: "hello there" });
    expect(res.body).toEqual(expect.objectContaining({ status: "blocked" }));
    expect(claude.texts).toEqual([]);
    expect(claude.keys).toEqual([]);
  });

  test("force types past the refusal, but never sweeps and never submits blind", async () => {
    const claude = new FakeClaude();
    claude.dialog = true;
    const res = await send(claude, { text: "hello there", force: true });
    expect(res.body).toEqual(expect.objectContaining({ status: "stalled" }));
    expect(claude.texts).toEqual(["hello there"]);
    expect(claude.keys).toEqual([]);
  });

  test("a stranded draft is cleared from the live read, then the reply is typed", async () => {
    const claude = new FakeClaude();
    claude.draft = "old words";
    const res = await send(claude, { text: "new message here" });
    expect(res.body).toEqual({ status: "sent" });
    expect(claude.keys.slice(0, 1 + 9 + 8)).toEqual(sweepKeys("old words"));
    expect(claude.submitted).toEqual(["new message here"]);
  });

  test("text that never reaches the box is never submitted", async () => {
    const claude = new FakeClaude();
    claude.swallowText = true;
    const res = await send(claude, { text: "into the void" });
    expect(res.body).toEqual(expect.objectContaining({ status: "stalled" }));
    expect(claude.keys).toEqual([]);
  });

  test("a harness with no readable box takes the one-shot send", async () => {
    const other = new FakeClaude();
    const res = await send(other, { text: "go" }, engineWith({ paneId: "w1:p1", agent: "codex", kind: "agent" }));
    expect(res.body).toEqual({ status: "sent" });
    expect(other.texts).toEqual(["go"]);
    expect(other.keys).toEqual(["Enter"]);
  });

  test("pi: types, sees the text in its editor, then submits once", async () => {
    const pi = new FakePi();
    const res = await send(pi, { text: PI_MESSAGE }, engineWith(PI));
    expect(res.body).toEqual({ status: "sent" });
    expect(pi.submitted).toEqual([PI_MESSAGE]);
    expect(pi.keys).toEqual(["Enter"]);
  });

  test("pi: an Enter refused during startup is pressed again once startup moves on", async () => {
    const pi = new FakePi(60);
    const res = await send(pi, { text: PI_MESSAGE }, engineWith(PI));
    expect(res.body).toEqual({ status: "sent" });
    expect(pi.refused).toBe(true);
    expect(pi.submitted).toEqual([PI_MESSAGE]);
    expect(pi.keys).toEqual(["Enter", "Enter"]);
  });

  test("pi: a startup that outlasts the wait gets no more Enters, and the text is reported in the box", async () => {
    const pi = new FakePi(100_000);
    const res = await send(pi, { text: PI_MESSAGE }, engineWith(PI));
    expect(res.body).toEqual(expect.objectContaining({ status: "error", textDelivered: true }));
    expect(pi.keys).toEqual(["Enter"]);
    expect(pi.submitted).toEqual([]);
    expect(pi.draft).toBe(PI_MESSAGE);
  });

  test("pi: text that never reaches the editor is never submitted", async () => {
    const pi = new FakePi();
    pi.sendPaneText = (_p: string, t: string) => {
      pi.texts.push(t);
      return Promise.resolve();
    };
    const res = await send(pi, { text: PI_MESSAGE }, engineWith(PI));
    expect(res.body).toEqual(expect.objectContaining({ status: "stalled" }));
    expect(pi.keys).toEqual([]);
  });

  test("a shell takes the one-shot send", async () => {
    const shell = new FakeClaude();
    const res = await send(shell, { text: "ls" }, engineWith({ paneId: "w1:p1", agent: "shell", kind: "shell" }));
    expect(res.body).toEqual({ status: "sent" });
    expect(shell.keys).toEqual(["Enter"]);
  });

  test("an unknown pane is a 404, so an old client knows to fall back", async () => {
    const res = await send(new FakeClaude(), { text: "hi" }, ({ current: () => ({ agents: [], shellPanes: [] }) }) as unknown as StateEngine);
    expect(res.status).toBe(404);
  });

  test("a bad body is refused before anything is written", async () => {
    const claude = new FakeClaude();
    expect((await send(claude, { text: "" })).status).toBe(400);
    expect((await send(claude, { text: "x", force: "yes" })).status).toBe(400);
    expect(claude.texts).toEqual([]);
  });

  test("the send is audited with its outcome", async () => {
    const lines: string[] = [];
    const audit = new AuditLog((l: string) => { lines.push(l); });
    await send(new FakeClaude(), { text: "audit me please" }, CLAUDE, audit);
    const entry = lines.map((l) => JSON.parse(l)).find((e) => e.action === "send");
    expect(entry).toEqual(expect.objectContaining({ paneId: "w1:p1", detail: expect.objectContaining({ status: "sent" }) }));
  });

  test("sweepKeys sizes from the draft, capped", () => {
    expect(sweepKeys("abc")).toEqual(["ctrl+k", ...Array(11).fill("Backspace")]);
    expect(sweepKeys("x".repeat(500)).length).toBe(1 + 96);
  });
});
