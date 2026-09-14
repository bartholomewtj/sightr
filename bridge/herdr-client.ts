import type { AgentStatus } from "../shared/wire.ts";
import { dialHerdr, type SockHandle } from "./dial.ts";
import { decodeReplyLine, decodeStreamLine } from "./wire.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The Herdr socket adapter. THIS IS THE ONLY FILE that knows Herdr's method names
// and wire shapes. Everything else talks to the typed methods below, so a Herdr
// API change is a one-file fix. Protocol facts are documented in HERDR_API.md.
//
// Key fact: RPC is ONE-SHOT — the server closes the connection after a single
// response. So every request opens a fresh connection, reads one line, closes.
// ─────────────────────────────────────────────────────────────────────────────

/** Git checkout provenance on a workspace (omitted when Herdr didn't open it as a worktree). */
export interface WireWorkspaceWorktree {
  repo_key: string;
  repo_name: string;
  repo_root: string;
  checkout_path: string;
  is_linked_worktree: boolean;
}

/** Raw wire shape of a workspace from `workspace.list`. */
interface WireWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status: AgentStatus;
  worktree?: WireWorkspaceWorktree | null;
}

/** One Git checkout from `worktree.list`. */
export interface WireWorktree {
  path: string;
  label: string;
  branch: string | null;
  is_bare: boolean;
  is_detached: boolean;
  is_prunable: boolean;
  is_linked_worktree: boolean;
  open_workspace_id?: string | null;
}

/** Repo identity returned alongside `worktree.list`. */
export interface WireWorktreeSource {
  repo_key: string;
  repo_name: string;
  repo_root: string;
  source_checkout_path: string;
  source_workspace_id?: string | null;
}

export interface WorktreeList {
  source: WireWorktreeSource;
  worktrees: WireWorktree[];
}

/** Raw wire shape of a tab from `tab.list`. */
interface WireTab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
}

/** Raw wire shape of a pane from `pane.list` (and, identically, inside `session.snapshot`). */
interface WirePane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd: string;
  foreground_cwd?: string;
  agent?: string | null;
  agent_status: AgentStatus;
  /** User-set pane label (herdr `pane.rename`). Present only once set — the key disappears when
   *  cleared with `label: null`, so absent/null both read as "no label". */
  label?: string | null;
  /**
   * The pane's OSC title, as the process running in it set it, and Herdr's own attempt at stripping
   * a leading status glyph off it. Both optional: older servers omit them.
   *
   * Carried on the PANE — not only on `session.snapshot`'s `agents[]`. Agents still derive from
   * `panes`; `agents[]` is joined only for the live name and summary token (see {@link WireAgent}).
   *
   * `terminal_title_stripped` is NOT a drop-in for display. Herdr strips the settled `✳` but leaves
   * Claude's rotating spinner frames in place (live-observed in one snapshot: `✳ Read Notes From
   * Underground` stripped, `◐ Custom UI for Sightr…` not). Those frames advance on every poll, so a
   * label bound straight to it churns. `meaningfulTerminalTitle` does the strip Sightr can rely on.
   */
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  revision: number;
  /**
   * The agent's OWN session identity, as the agent reported it to Herdr (herdr ≥ 0.7.2). For Claude
   * this is `{kind:"id", value:"<uuid>"}` — the uuid naming its on-disk session log, which is how
   * Sightr serves real conversation history for a pane whose terminal keeps no scrollback (see
   * transcript.ts). Optional + defensively typed: older servers omit it, and `kind` may be something
   * other than "id" for other agents.
   */
  agent_session?: {
    source?: string;
    agent?: string;
    kind?: string;
    value?: string;
  } | null;
  /**
   * Scroll geometry (herdr ≥ 0.7.2); optional so older servers that omit it still typecheck.
   *
   * `max_offset_from_bottom` is how far the pane can scroll UP — the depth of its scrollback ring —
   * so `max_offset_from_bottom + viewport_rows` is the line count a `pane.read source:"recent"` can
   * return. Live-verified on a sandbox pane (2026-07-26): 95+31 → 127 lines read, 498+31 → 530 (the
   * +1 is the trailing newline). Exact once scrollback exists; an OVER-estimate on a near-empty
   * screen, where trailing blank rows are trimmed from the read (0+31 → 4 lines read).
   *
   * This is the only trustworthy "is there more to load" signal Herdr gives us — `PaneRead.truncated`
   * is ALWAYS false, even when a read demonstrably cut scrollback off (200 requested of 6895
   * available still reports `truncated: false`). Gate on this, never on `truncated`.
   */
  scroll?: {
    offset_from_bottom: number;
    max_offset_from_bottom: number;
    viewport_rows: number;
  } | null;
}

/**
 * One entry from `session.snapshot`'s `agents[]` (herdr ≥ 0.7.2). Not a second herd: Sightr still
 * derives agent vs shell from `panes`. This record is the only place Herdr puts the live agent
 * name (`agent.rename` / `agent.start`) and display tokens such as `summary`.
 */
export interface WireAgent {
  pane_id: string;
  name?: string | null;
  title?: string | null;
  tokens?: Record<string, string> | null;
}

/**
 * Raw shape of `session.snapshot` — the whole herd in one reply, superseding the three parallel
 * list calls. `layouts`/`focused_*` stay unused. `agents` is joined onto pane views for name and
 * summary only — the agent list itself still comes from `panes`. Older servers predate the method
 * (see StateEngine).
 */
export interface WireSnapshot {
  version: string;
  protocol: number;
  workspaces: WireWorkspace[];
  tabs: WireTab[];
  panes: WirePane[];
  agents?: WireAgent[];
}

/** The freshly-created shell pane returned by tab.create / workspace.create (`root_pane`). */
export interface CreatedShell {
  paneId: string;
  workspaceId: string;
  workspaceLabel?: string;
  tabId: string;
  cwd: string;
}

export interface PaneRead {
  pane_id: string;
  text: string;
  truncated: boolean;
  revision: number;
}

// Wire names are snake_case: `recent-unwrapped` is REJECTED by the server (`unknown variant`,
// live-probed 2026-08-03, herdr 0.7.5). Nothing called it before that probe, so the kebab spelling
// this type carried since day one was never caught. `detection` also exists (listed by the server's
// own error message); semantics unverified, so it stays out of the union until something needs it.
type ReadSource = "visible" | "recent" | "recent_unwrapped";
type ReadFormat = "text" | "ansi";

/** Herdr error code from a `herdr <method>: <code>: <message>` throw, or undefined. */
export function herdrErrorCode(err: unknown): string | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  return /^herdr [^\s:]+: ([a-z0-9_]+):/i.exec(msg)?.[1];
}

let idCounter = 0;

/** Per-request wall-clock budget. */
export const DEFAULT_TIMEOUT_MS = 5000;

export class HerdrClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  /** One request, one reply, one connection. Rejects on error reply, timeout, or early close. */
  private request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = `b${++idCounter}`;
    return new Promise<T>((resolve, reject) => {
      let buf = "";
      let settled = false;
      // The live socket, once the dial opens one. Hoisted so EVERY terminal path (timeout
      // included) can close it — otherwise a timeout leaves the FD dangling.
      let socket: SockHandle | null = null;
      // Aborts a dial that is still connecting — a timeout that fires mid-connect has no socket
      // to end() yet, and without this the pending OS handle lives until the connect settles.
      let cancelDial: (() => void) | null = null;
      // Stream-decode so a multi-byte UTF-8 codepoint split across chunk boundaries isn't
      // corrupted into replacement characters.
      const decoder = new TextDecoder("utf-8");
      // Settle BEFORE closing: socket.end() synchronously fires `close`, which re-enters finish —
      // but `settled` is already set there, so that reject is a no-op and we keep the real outcome.
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
        if (socket) {
          try {
            socket.end();
          } catch {
            /* ignore */
          }
          socket = null;
        } else if (cancelDial) {
          // Timed out (or failed) while still connecting — abort the in-flight dial.
          try {
            cancelDial();
          } catch {
            /* ignore */
          }
        }
        cancelDial = null;
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`herdr ${method}: timed out after ${this.timeoutMs}ms`))),
        this.timeoutMs,
      );

      dialHerdr(this.socketPath, {
        onDial(cancel) {
          cancelDial = cancel;
        },
        open(s) {
          socket = s;
        },
        data(s, chunk) {
          socket = s;
          buf += decoder.decode(chunk, { stream: true });
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          finish(() => {
            try {
              resolve(decodeReplyLine<T>(line, method));
            } catch (e) {
              reject(e as Error);
            }
          });
        },
        error(_s, err) {
          finish(() => reject(err));
        },
        close() {
          finish(() => reject(new Error(`herdr ${method}: connection closed before reply`)));
        },
      })
        .then((s) => {
          // Already settled (e.g. timed out) before the connection opened — close it so the FD
          // doesn't leak, and don't bother writing.
          if (settled) {
            try {
              s.end();
            } catch {
              /* ignore */
            }
            return;
          }
          socket = s;
          // Write only once the connection is established — matches the verified probe pattern.
          // A long request (a big paste, a wide pane's text) can exceed what the socket accepts in
          // one go; the dialer owns that continuation, so there is nothing to retry here (dial.ts).
          // A connection that dies mid-write lands in close/error above and rejects like any other
          // transport failure.
          s.write(JSON.stringify({ id, method, params }) + "\n");
          s.flush();
        })
        .catch((err) => finish(() => reject(err)));
    });
  }

  async listWorkspaces(): Promise<WireWorkspace[]> {
    const r = await this.request<{ workspaces: WireWorkspace[] }>("workspace.list");
    return r.workspaces;
  }

  async listPanes(): Promise<WirePane[]> {
    const r = await this.request<{ panes: WirePane[] }>("pane.list");
    return r.panes;
  }

  /** All tabs across every workspace (`tab.list` with no filter returns the full set). */
  async listTabs(): Promise<WireTab[]> {
    const r = await this.request<{ tabs: WireTab[] }>("tab.list");
    return r.tabs;
  }

  /**
   * The whole herd in one round-trip (herdr ≥ 0.7.2). Replaces workspace.list + pane.list +
   * tab.list for the poll loop. An older server rejects the method with an "unknown variant" error
   * reply — StateEngine treats only that as a permanent signal to fall back to the three list calls.
   */
  async sessionSnapshot(): Promise<WireSnapshot> {
    const r = await this.request<{ type: string; snapshot: WireSnapshot }>("session.snapshot");
    return r.snapshot;
  }

  /**
   * Open a LONG-LIVED `events.subscribe` stream. Unlike every other method here (one-shot), this
   * connection stays open: after the ack, each line is an event. It exists ONLY to poke re-polls —
   * callers must not treat events as state. `onDown` fires exactly once when the stream ends for any
   * reason (error line, socket error, close, or a 5s ack timeout); `close()` is idempotent and also
   * ends it with reason "closed". Reconnect/backoff live in the caller (see EventPoker).
   */
  subscribeEvents(opts: {
    subscriptions: Array<{ type: string; pane_id?: string }>;
    onUp: () => void;
    onEvent: (event: string, data: unknown) => void;
    onDown: (reason: string) => void;
  }): { close(): void } {
    const id = `es${++idCounter}`;
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let socket: SockHandle | null = null;
    let cancelDial: (() => void) | null = null;
    let down = false;
    let acked = false;

    // The single terminal path. Guarded so onDown never fires twice, and closes the FD once.
    const fireDown = (reason: string) => {
      if (down) return;
      down = true;
      clearTimeout(ackTimer);
      if (socket) {
        try {
          socket.end();
        } catch {
          /* ignore */
        }
        socket = null;
      } else if (cancelDial) {
        // Ack timeout (or close()) while the dial was still connecting — abort it so repeated
        // reconnect attempts can't stack pending OS handles.
        try {
          cancelDial();
        } catch {
          /* ignore */
        }
      }
      cancelDial = null;
      opts.onDown(reason);
    };

    // A server that accepts the connection but never acks (hung) counts as down, not healthy.
    const ackTimer = setTimeout(() => fireDown("ack timeout"), 5000);

    const handleLine = (line: string) => {
      if (line === "") return;
      let decoded;
      try {
        decoded = decodeStreamLine(line);
      } catch (e) {
        fireDown(`protocol error: ${(e as Error).message}`);
        return;
      }
      if (decoded.kind === "error") {
        fireDown(`${decoded.code}: ${decoded.message}`);
        return;
      }
      if (decoded.kind === "ack") {
        if (acked) return;
        acked = true;
        clearTimeout(ackTimer);
        opts.onUp();
        return;
      }
      opts.onEvent(decoded.event, decoded.data);
    };

    dialHerdr(this.socketPath, {
      onDial(cancel) {
        cancelDial = cancel;
      },
      open(s) {
        socket = s;
      },
      // Multiple lines can arrive per chunk (bursty events); drain ALL complete lines and keep the
      // stream open. Stream-decode so a multi-byte codepoint split across chunks isn't corrupted.
      data(s, chunk) {
        socket = s;
        buf += decoder.decode(chunk, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0 && !down) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          handleLine(line);
          nl = buf.indexOf("\n");
        }
      },
      error(_s, err) {
        fireDown(err.message || "socket error");
      },
      close() {
        fireDown("connection closed");
      },
    })
      .then((s) => {
        if (down) {
          try {
            s.end();
          } catch {
            /* ignore */
          }
          return;
        }
        socket = s;
        s.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions: opts.subscriptions } }) + "\n");
        s.flush();
      })
      .catch((err) => fireDown((err as Error).message || "connect failed"));

    return { close: () => fireDown("closed") };
  }

  /**
   * Create a new tab in a workspace, opening a fresh shell pane. `cwd` is optional — omitted, the
   * tab inherits the workspace's directory (verified). `focus:false` so we never yank the desktop
   * TUI's focus. Returns the new shell pane to navigate into.
   */
  async createTab(workspaceId: string, opts: { label?: string; cwd?: string } = {}): Promise<CreatedShell> {
    const params: Record<string, unknown> = { workspace_id: workspaceId, focus: false };
    if (opts.label) params.label = opts.label;
    if (opts.cwd) params.cwd = opts.cwd;
    const r = await this.request<{ root_pane: WirePane }>("tab.create", params);
    const p = r.root_pane;
    return { paneId: p.pane_id, workspaceId: p.workspace_id, tabId: p.tab_id, cwd: p.cwd };
  }

  /**
   * Create a new workspace ("space") with a fresh shell pane rooted at `cwd`. `focus:false` to
   * leave the desktop TUI undisturbed. Returns the new shell pane (with its workspace label).
   */
  async createWorkspace(opts: { cwd: string; label?: string }): Promise<CreatedShell> {
    const params: Record<string, unknown> = { cwd: opts.cwd, focus: false };
    if (opts.label) params.label = opts.label;
    const r = await this.request<{
      workspace: WireWorkspace;
      root_pane: WirePane;
    }>("workspace.create", params);
    const p = r.root_pane;
    return {
      paneId: p.pane_id,
      workspaceId: p.workspace_id,
      workspaceLabel: r.workspace.label,
      tabId: p.tab_id,
      cwd: p.cwd,
    };
  }

  async readPane(
    paneId: string,
    source: ReadSource,
    lines: number,
    format: ReadFormat = "text",
  ): Promise<PaneRead> {
    const r = await this.request<{ read: PaneRead }>("pane.read", {
      pane_id: paneId,
      source,
      lines,
      // "text" = plain (no escapes); "ansi" = SGR color codes (verified: no cursor sequences),
      // parsed + escaped safely on the client to render a faithful, colored terminal mirror.
      format,
    });
    return r.read;
  }

  /** Type literal text into a pane's terminal (does not submit). */
  sendPaneText(paneId: string, text: string): Promise<void> {
    return this.request<void>("pane.send_text", { pane_id: paneId, text });
  }

  /** Send key names (e.g. ["Enter"]) to a pane — used to submit a reply. */
  sendPaneKeys(paneId: string, keys: string[]): Promise<void> {
    return this.request<void>("pane.send_keys", { pane_id: paneId, keys });
  }

  /** Close a pane, terminating its agent ("kill"). Resolves on Herdr's `{type:"ok"}` reply. */
  closePane(paneId: string): Promise<void> {
    return this.request<void>("pane.close", { pane_id: paneId });
  }

  /**
   * Set or clear a pane's label. `label: null` clears it (the key then disappears from pane
   * records). Resolves on Herdr's `pane_info` reply — the returned pane isn't consumed here, the
   * next snapshot poll carries the new label (pane.rename emits no event). Bad id → `pane_not_found`.
   */
  renamePane(paneId: string, label: string | null): Promise<void> {
    return this.request<void>("pane.rename", { pane_id: paneId, label });
  }

  /**
   * Set a tab's label. Unlike {@link renamePane}, `label` is a NON-null string: herdr's `tab.rename`
   * rejects `null` (`invalid type: null, expected a string`) and stores an empty string literally
   * rather than clearing to the default number — both live-verified 2026-07-19 — so a tab has no
   * "clear". Resolves on herdr's `tab_info` reply; the new label surfaces on the next snapshot poll
   * (tab.rename also emits a `tab_renamed` event, which Sightr doesn't consume). Bad id → `tab_not_found`.
   */
  renameTab(tabId: string, label: string): Promise<void> {
    return this.request<void>("tab.rename", { tab_id: tabId, label });
  }

  /**
   * Set a workspace's label. Like {@link renameTab} and unlike {@link renamePane}, `label` is a
   * NON-null, non-empty string — herdr has no "clear" for a workspace (HERDR_API.md "Rename methods").
   * Resolves on herdr's `workspace_info` reply; the new label surfaces on the next snapshot poll
   * (workspace.rename also emits `workspace_renamed`, which event-poker already subscribes to, so a
   * rename pokes an immediate re-poll). Bad id → `workspace_not_found`.
   */
  renameWorkspace(workspaceId: string, label: string): Promise<void> {
    return this.request<void>("workspace.rename", { workspace_id: workspaceId, label });
  }

  /**
   * Close a tab, terminating EVERY pane inside it (live-verified 2026-07-19: the tab's shell/agent
   * panes all disappear with it — closing a tab is a bulk pane-close). Resolves on herdr's
   * `{type:"ok"}` reply; the closure surfaces on the next `session.snapshot` poll (tab.close also
   * emits a `tab_closed` event, which Sightr doesn't consume). Bad id → `tab_not_found`.
   */
  closeTab(tabId: string): Promise<void> {
    return this.request<void>("tab.close", { tab_id: tabId });
  }

  /**
   * Close a workspace, terminating every tab and pane inside it. `closeGroup` is required by Herdr
   * when this is the primary workspace of an open linked-worktree group; without it Herdr returns
   * `workspace_group_close_required` and leaves the group up. Closes Herdr state only — checkouts
   * and branches stay on disk (use {@link removeWorktree} to delete a linked checkout).
   */
  closeWorkspace(workspaceId: string, opts: { closeGroup?: boolean } = {}): Promise<void> {
    const params: Record<string, unknown> = { workspace_id: workspaceId };
    if (opts.closeGroup) params.close_group = true;
    return this.request<void>("workspace.close", params);
  }

  /** Git worktrees for a workspace or cwd. `not_git_worktree` when the target is not a checkout. */
  listWorktrees(opts: { workspaceId?: string; cwd?: string } = {}): Promise<WorktreeList> {
    const params: Record<string, unknown> = {};
    if (opts.workspaceId) params.workspace_id = opts.workspaceId;
    if (opts.cwd) params.cwd = opts.cwd;
    return this.request<WorktreeList>("worktree.list", params);
  }

  /**
   * Open an existing Git worktree as a Herdr workspace, grouped with the parent repo. `focus:false`
   * so the desktop TUI stays put. Returns the new (or already-open) shell pane.
   */
  async openWorktree(opts: {
    workspaceId?: string;
    cwd?: string;
    path?: string;
    branch?: string;
  }): Promise<CreatedShell> {
    const params: Record<string, unknown> = { focus: false };
    if (opts.workspaceId) params.workspace_id = opts.workspaceId;
    if (opts.cwd) params.cwd = opts.cwd;
    if (opts.path) params.path = opts.path;
    if (opts.branch) params.branch = opts.branch;
    const r = await this.request<{
      workspace: WireWorkspace;
      root_pane: WirePane;
    }>("worktree.open", params);
    const p = r.root_pane;
    return {
      paneId: p.pane_id,
      workspaceId: p.workspace_id,
      workspaceLabel: r.workspace.label,
      tabId: p.tab_id,
      cwd: p.cwd,
    };
  }

  /**
   * Delete a linked worktree checkout (`git worktree remove`). Never deletes the branch. `force`
   * is required when Git refuses a dirty checkout. The linked workspace is closed if it was open.
   */
  removeWorktree(workspaceId: string, opts: { force?: boolean } = {}): Promise<void> {
    return this.request<void>("worktree.remove", {
      workspace_id: workspaceId,
      force: opts.force ?? false,
    });
  }

  /** Reachability check for the connected/disconnected banner. */
  async ping(): Promise<boolean> {
    try {
      await this.listWorkspaces();
      return true;
    } catch {
      return false;
    }
  }
}
