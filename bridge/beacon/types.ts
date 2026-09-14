import type { AgentSessionRef } from "../journal/types.ts";

// THE BEACON CONTRACT — what an agent may tell Sightr about itself, and nothing more.
//
// Sightr works out who is in a pane by reading a picture of it: the `/rename` session name comes
// off the rendered grid (`enrichSessionNames` in ../state-engine.ts) and history is joined by
// matching logs against what is on screen. Both are inference. The agent itself knows exactly who it
// is, and a beacon is the one way it can say so: Claude's own hooks write this record, Sightr reads
// it, and nothing is guessed.
//
// ── A BEACON IS A HINT, NEVER A CONTROL CHANNEL ──────────────────────────────────────────────────
//
// Everything below is READ. No field here can cause a send, a key, a rename, a close or a focus, arm
// a mode, relax a guard or bypass a gate. Anything that can WRITE into the beacon directory is the
// threat model — not the operator who installed the hook — so the session ref a beacon carries has
// exactly the standing of one Herdr reports: it reaches the filesystem only through the containment
// in ../journal/files.ts, or not at all.
//
// ── KEYED BY THE PANE, NOT THE SESSION ───────────────────────────────────────────────────────────
//
// One file per pane, named by the pane id (../beacon/paths.ts). Keying by session id would make
// `/clear` — which mints a new session id inside the same pane — leave a stale beacon beside the
// fresh one, and the pane would carry two identities until a TTL expired one. Keyed by the pane,
// `/clear` is an ordinary overwrite. One live agent per pane is the truth on Herdr.

/**
 * The format version this build writes and reads.
 *
 * A record from a NEWER schema is skipped rather than guessed at (parse.ts): a version we do not
 * know may mean a field we DO know differently, and a misread identity is worse than an absent one.
 */
export const BEACON_SCHEMA_VERSION = 1;

/**
 * The heartbeat backstop, and it must be LONGER THAN ANY SINGLE AGENT TURN: a Claude session can
 * think for half an hour with no hook firing between `UserPromptSubmit` and `Stop`, so a short TTL
 * would expire an agent that is working. Twelve hours is far above any turn and far below a day, so
 * yesterday's crashed session is never today's identity.
 *
 * Upstream backs this up with a pid start-time probe read out of `/proc`, which does not exist on
 * Windows. The heartbeat is therefore the whole liveness signal here, which is why it is generous.
 */
export const BEACON_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * The beacon's OWN status vocabulary — three words.
 *
 * Deliberately NOT `AgentStatus`. Sightr's five words are a triage vocabulary with no `waiting` in
 * them, and mapping into it (`waiting → blocked`, because `STATUS_RANK.blocked = 0`) is a decision
 * about how Sightr SORTS, which belongs to the decorator and not to the file format.
 */
export type BeaconStatus = "working" | "waiting" | "idle";

/** The status words, as a runtime list — `parse.ts` checks an on-disk value against this. */
export const BEACON_STATUSES: readonly BeaconStatus[] = ["working", "waiting", "idle"];

/**
 * One beacon file, as it is on disk. Every field is something an agent's own hook could truthfully
 * say about itself, and nothing here is an instruction.
 */
export interface BeaconRecord {
  /** {@link BEACON_SCHEMA_VERSION} at the time of writing. A different value is not read. */
  readonly schemaVersion: number;
  /** The harness the agent is, in the journal registry's vocabulary (`claude`). */
  readonly harness: string;
  /** The pane it is in — raw `HERDR_PANE_ID`, exactly as the emitter read it. */
  readonly paneId: string;
  /** How the agent named its session — the journal's own ref type, not a new one. */
  readonly session: AgentSessionRef;
  /** The name a human reads, when the harness reports one. Never fabricated from the id. */
  readonly sessionName?: string;
  /** What the agent was doing at {@link BeaconRecord.heartbeatMs}. */
  readonly status: BeaconStatus;
  /** Epoch ms of the last hook event. The TTL is measured from here ({@link BEACON_TTL_MS}). */
  readonly heartbeatMs: number;
}

/**
 * What one beacon means RIGHT NOW — and the expired/live split is in this type rather than in a
 * comment, because it is the rule this work can most easily get wrong.
 *
 * An EXPIRED beacon still supplies `session` and `harness`: history is history, and a finished
 * conversation is still readable. What it stops supplying is `status` — the `live` variant is the
 * only one that carries the field at all, so there is no way to read a stale status by accident.
 *
 * There is deliberately no third "absent" variant: the reader simply returns nothing for that pane.
 * "No beacon" and "the agent is resting" look identical from outside and mean opposite things to a
 * triage sort, so absence must never become `idle`.
 */
export type BeaconReading =
  | {
      readonly liveness: "live";
      readonly paneId: string;
      readonly harness: string;
      readonly session: AgentSessionRef;
      readonly sessionName?: string;
      readonly status: BeaconStatus;
    }
  | {
      readonly liveness: "expired";
      readonly paneId: string;
      readonly harness: string;
      readonly session: AgentSessionRef;
      readonly sessionName?: string;
    };
