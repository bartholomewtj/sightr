// The journal's shared vocabulary — the shape every harness adapter must produce, and the seams the
// store drives them through. Nothing agent-specific lives here.
//
// WHY A JOURNAL EXISTS AT ALL. A pane running an agent usually sits on the terminal's ALTERNATE
// SCREEN, which has no scrollback ring — Herdr's terminal core keeps nothing behind the viewport, so
// `pane.read` can never return more than one screenful (see journal/claude.ts for the measurements).
// The history does exist, though: every harness writes its own session log. This module's job is to
// make "read that log" a per-harness decision behind one interface, so a new harness is an adapter
// rather than a fork of the reader.

/**
 * How an agent named its session, straight off Herdr's `agent_session` record.
 *
 * Two kinds are in the wild and they are NOT interchangeable:
 *  - `id`   — an opaque session id (Claude). The adapter must find the file itself, so the
 *             value never touches a path until the adapter has validated its shape.
 *  - `path` — an absolute path to the log, reported by the agent (pi). Convenient, but it is
 *             attacker-shaped input by construction: it arrives over the socket from a process we
 *             do not control, so the adapter must still confine it to its own root.
 */
export interface AgentSessionRef {
  kind: "id" | "path";
  value: string;
}

import type { TranscriptEntry } from "../../shared/wire.ts";
export type { TranscriptPart, TranscriptEntry } from "../../shared/wire.ts";

/** What the history endpoint answers with, minus the pane id the route adds. */
export interface TranscriptPage {
  paneId: string;
  /** Oldest-first, ready to render top-down. */
  entries: TranscriptEntry[];
  /** True when older turns exist before `entries[0]` — drives "load older". */
  hasMore: boolean;
  /** Total turns available in the parsed window (after sidechain filtering). */
  total: number;
  /** True when the on-disk log exceeded the byte cap and we kept only its tail. */
  fileTruncated: boolean;
}

/**
 * The fs seam. Real implementations live beside each adapter; tests inject a fake so no temp files
 * are needed (the repo convention — see sessions.test.ts / state-engine.test.ts).
 */
export interface TranscriptSource {
  /** Absolute path of the log this ref names, or null when it isn't on disk / isn't ours to read. */
  resolve(ref: AgentSessionRef): Promise<string | null>;
  /**
   * Size + mtime of a log, WITHOUT reading it — the store's cache-validity check.
   *
   * Split out from `load` on purpose: a journal can be 32 MB, and paging back through a long
   * conversation asks for the same file over and over. Reading it to discover the cache was already
   * valid made every "load older" tap a full re-read.
   */
  stat(path: string): Promise<{ size: number; mtimeMs: number } | null>;
  /** Tail-read a log. `complete` is false when the byte cap clipped the head. */
  load(path: string): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }>;
}

/**
 * One harness's journal support: how to find its log, and how to read its grammar.
 *
 * `agent` is matched against the Herdr snapshot's `agent` string, and it is also the registry key —
 * the map is built FROM this field so the two can never drift (journal/registry.ts). An agent with
 * no adapter simply has no journal, which the route reports as an ordinary "no-session".
 *
 * `parse` is PURE — no fs, no clock — so every harness's grammar is table-testable under `bun test`.
 */
/**
 * How a cwd-keyed harness (Grok) picks a session when Herdr named none.
 *
 * A string is the pane cwd — a one-off lookup with nothing remembered (the newest session there).
 * The object form is what the history route passes. Several grok tabs in one space share a log
 * directory, so the answer has to be per-pane: `paneId` is the identity a claim is recorded
 * against, and `hint` is the live viewport plus terminal title that evidence is read from.
 *
 * `peerPaneIds` is every pane at this cwd still running this agent, including this one. It is how
 * the adapter learns that a pane has gone away or switched harness, so that pane's claim on a log
 * can be released instead of reserving it forever (journal/claims.ts).
 *
 * `reportedSessionId` is what Herdr says this pane is on, when it says anything. For a cwd-keyed
 * harness that is a HINT, not an answer: Herdr's grok integration reports the session the pane
 * started with and does not follow a new one opened later in the same pane. It ranks above a blind
 * guess and below anything the pane itself is showing.
 */
export type InferSessionOpts = {
  cwd: string;
  paneId?: string;
  hint?: string;
  peerPaneIds?: readonly string[];
  reportedSessionId?: string;
};

export interface JournalAdapter {
  readonly agent: string;
  readonly source: TranscriptSource;
  parse(text: string): TranscriptEntry[];
  /**
   * When Herdr named no session, find one from the pane's cwd. Optional: only harnesses whose log
   * layout is keyed by cwd (Grok) implement it. A miss is `null`, same as "no-log".
   */
  inferFromCwd?(cwdOrOpts: string | InferSessionOpts): Promise<AgentSessionRef | null>;
}
