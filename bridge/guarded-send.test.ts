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
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as { status: string; error?: string; noEcho?: string }) : await res.text() };
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
    const pi = new FakeClaude();
    const res = await send(pi, { text: "go" }, engineWith({ paneId: "w1:p1", agent: "pi", kind: "agent" }));
    expect(res.body).toEqual({ status: "sent" });
    expect(pi.texts).toEqual(["go"]);
    expect(pi.keys).toEqual(["Enter"]);
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
