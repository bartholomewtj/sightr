import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

type WireWorkspaceLike = {
  workspace_id: string; number: number; label: string; focused: boolean;
  pane_count: number; tab_count: number; active_tab_id: string; agent_status: string;
};
type WireTabLike = {
  tab_id: string; workspace_id: string; number: number; label: string; focused: boolean;
  pane_count: number; agent_status: string;
};
type WirePaneLike = {
  pane_id: string; terminal_id: string; workspace_id: string; tab_id: string; focused: boolean;
  cwd: string; agent: string; agent_status: string; revision: number;
  scroll: { offset_from_bottom: number; max_offset_from_bottom: number; viewport_rows: number };
};

export interface FakeHerd {
  workspaces: WireWorkspaceLike[];
  tabs: WireTabLike[];
  panes: WirePaneLike[];
  paneText: Map<string, string>;
  sentKeys: Array<{ paneId: string; keys: string[] }>;
  sentText: Array<{ paneId: string; text: string }>;
}

export function permissionBashFixture(): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "src", "fixtures", "panes", "claude--permission-bash.txt");
  return readFileSync(path, "utf8");
}

export function createFakeHerd(overrides: Partial<FakeHerd> = {}): FakeHerd {
  const paneId = "ws1:pane1";
  return {
    workspaces: [{ workspace_id: "ws1", number: 1, label: "e2e", focused: true, pane_count: 1, tab_count: 1, active_tab_id: "tab1", agent_status: "blocked" }],
    tabs: [{ tab_id: "tab1", workspace_id: "ws1", number: 1, label: "1", focused: true, pane_count: 1, agent_status: "blocked" }],
    panes: [{ pane_id: paneId, terminal_id: "t1", workspace_id: "ws1", tab_id: "tab1", focused: true, cwd: "/tmp/sightr-e2e", agent: "claude", agent_status: "blocked", revision: 1, scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 60 } }],
    paneText: new Map([[paneId, permissionBashFixture()]]),
    sentKeys: [],
    sentText: [],
    ...overrides,
  };
}

type RpcMessage = { id: string; method: string; params?: Record<string, unknown> };
type RpcReply = { id: string; result: unknown } | { id: string; error: { code: string; message: string } };

export function handleRpc(herd: FakeHerd, msg: RpcMessage): RpcReply | null {
  const params = msg.params ?? {};
  if (msg.method === "events.subscribe") return null;
  if (msg.method === "session.snapshot") {
    return { id: msg.id, result: { type: "session_snapshot", snapshot: { version: "0.7.5", protocol: 16, workspaces: herd.workspaces, tabs: herd.tabs, panes: herd.panes } } };
  }
  if (msg.method === "workspace.list") return { id: msg.id, result: { workspaces: herd.workspaces } };
  if (msg.method === "tab.list") return { id: msg.id, result: { tabs: herd.tabs } };
  if (msg.method === "pane.list") return { id: msg.id, result: { panes: herd.panes } };
  if (msg.method === "pane.read") {
    const paneId = String(params.pane_id ?? "");
    const pane = herd.panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) return { id: msg.id, error: { code: "pane_not_found", message: paneId } };
    return { id: msg.id, result: { read: { pane_id: paneId, text: herd.paneText.get(paneId) ?? "", truncated: false, revision: pane.revision } } };
  }
  if (msg.method === "pane.send_text" || msg.method === "pane.send_keys") {
    const paneId = String(params.pane_id ?? "");
    if (!herd.panes.some((pane) => pane.pane_id === paneId)) return { id: msg.id, error: { code: "pane_not_found", message: paneId } };
    if (msg.method === "pane.send_text") herd.sentText.push({ paneId, text: String(params.text ?? "") });
    else herd.sentKeys.push({ paneId, keys: Array.isArray(params.keys) ? params.keys.map(String) : [] });
    return { id: msg.id, result: {} };
  }
  return { id: msg.id, error: { code: "unknown_method", message: msg.method } };
}

export class FakeHerdrClient {
  text = "Approve this command?\n1. Yes\n2. No";
  readonly reads: Array<[string, string, number, string]> = [];
  readonly texts: Array<[string, string]> = [];
  readonly keys: Array<[string, string[]]> = [];

  readPane(paneId: string, source: string, lines: number, format: string): Promise<{ pane_id: string; text: string; truncated: boolean; revision: number }> {
    this.reads.push([paneId, source, lines, format]);
    return Promise.resolve({ pane_id: paneId, text: this.text, truncated: false, revision: 1 });
  }
  sendPaneText(paneId: string, text: string): Promise<void> { this.texts.push([paneId, text]); return Promise.resolve(); }
  sendPaneKeys(paneId: string, keys: string[]): Promise<void> { this.keys.push([paneId, keys]); return Promise.resolve(); }
}

export async function startFakeHerdr(opts: { herd?: FakeHerd; socketPath?: string } = {}): Promise<{ herd: FakeHerd; socketPath: string; stop(): Promise<void> }> {
  const herd = opts.herd ?? createFakeHerd();
  const tempDir = opts.socketPath ? undefined : mkdtempSync(join(tmpdir(), "sightr-e2e-"));
  const socketPath = opts.socketPath ?? (process.platform === "win32" ? `\\\\.\\pipe\\sightr-e2e-${process.pid}-${Date.now()}\\herdr.sock` : join(tempDir!, "herdr.sock"));
  const sockets = new Set<Socket>();
  let bufferBySocket = new Map<Socket, string>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    bufferBySocket.set(socket, "");
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") socket.destroy();
    });
    socket.on("data", (chunk: Buffer) => {
      const next = (bufferBySocket.get(socket) ?? "") + chunk.toString("utf8");
      const lines = next.split("\n");
      bufferBySocket.set(socket, lines.pop() ?? "");
      for (const line of lines) {
        if (!line) continue;
        let msg: RpcMessage;
        try { msg = JSON.parse(line) as RpcMessage; } catch { socket.destroy(); return; }
        if (msg.method === "events.subscribe") {
          socket.write(JSON.stringify({ id: msg.id, result: { type: "subscription_started" } }) + "\n");
          continue;
        }
        const reply = handleRpc(herd, msg);
        if (reply) socket.end(JSON.stringify(reply) + "\n");
      }
    });
    socket.on("close", () => { sockets.delete(socket); bufferBySocket.delete(socket); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve()); });
  return { herd, socketPath, async stop() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    bufferBySocket = new Map();
  } };
}
