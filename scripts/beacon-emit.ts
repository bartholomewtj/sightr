import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  beaconFileName,
  beaconsDir,
  BEACON_DIR_MODE,
  BEACON_FILE_MODE,
  isPaneId,
  resolveStateDir,
} from "../bridge/beacon/paths.ts";
import { BEACON_SCHEMA_VERSION, type BeaconRecord, type BeaconStatus } from "../bridge/beacon/types.ts";

// THE EMITTER — the half of a beacon that runs inside the agent, not inside Sightr.
//
// Claude Code runs this on five of its own hook events, with the hook payload as JSON on stdin and
// the event name as the first argument. It writes one small file naming the pane it is in, the
// session, and what the agent is doing. That is all it does.
//
// ── TWO CLAUDE CODE HAZARDS, BOTH ABSOLUTE ───────────────────────────────────────────────────────
//
// A `UserPromptSubmit` hook's STDOUT IS INJECTED INTO THE CONVERSATION as context, and a NON-ZERO
// EXIT BLOCKS THE PROMPT. So this script prints nothing — not to stdout, not to stderr — and exits 0
// on every path there is: not in a Herdr pane, malformed payload, an unwritable state dir, a full
// disk. A beacon that fails to write is a beacon that is ABSENT, which the reader already handles
// honestly. An emitter that can wedge the operator's agent is worse than no emitter at all.
//
// `SessionEnd` runs on a ~1.5 second budget, so: one environment read, one stdin read, one parse,
// one atomic write. No network, no subprocess, nothing that waits on another process.

/** One hook Claude fires, and what the agent is doing when it does. */
export interface HookRegistration {
  readonly event: string;
  /** Claude's own matcher for the event, when it has one. */
  readonly matcher?: string;
  readonly status: BeaconStatus;
}

/**
 * The hooks the installer registers, and the status each one means.
 *
 * `SessionStart` is first because it is the first moment there is an agent to name, and `session_id`
 * is in the payload from that moment — so the session ref is set before the first turn exists.
 *
 * `SessionEnd` carries a `reason`, and `reason: "clear"` IS NOT THE AGENT LEAVING: clearing the
 * conversation mints a NEW session id in the same pane. Nothing here branches on it, because nothing
 * has to — the beacon is keyed by the pane, so the next `UserPromptSubmit` re-keys the session ref by
 * overwriting the same file.
 */
export const BEACON_HOOKS: readonly HookRegistration[] = [
  { event: "SessionStart", status: "idle" },
  { event: "UserPromptSubmit", status: "working" },
  { event: "Stop", status: "idle" },
  { event: "SessionEnd", status: "idle" },
  // Matched on the event, never on the notification's message text: a status derived from prose
  // changes the day the prose does.
  { event: "Notification", matcher: "idle_prompt", status: "waiting" },
];

/** The harness this emitter speaks for, in the journal registry's vocabulary. */
export const BEACON_HARNESS = "claude";

/**
 * A session id, as the journal will use it.
 *
 * Pattern-validated HERE because of what it becomes: the journal builds a path from it inside a root
 * Sightr configured. A value that never leaves this shape can never leave that root either.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
/** A display name a human reads — the same shape the parse boundary accepts. */
const MAX_SESSION_NAME = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The record to write, or null meaning "write nothing".
 *
 * Pure, so every refusal below is unit-testable with no files and no live agent. The gates are in
 * this order because the cheapest one runs first: the hook is installed GLOBALLY, so it fires for
 * every agent on the host including ones Sightr will never see, and outside a Herdr pane it must
 * cost them one process spawn and nothing else — not a stdin read, not a parse.
 */
export function buildBeaconRecord(
  event: string | undefined,
  env: Record<string, string | undefined>,
  payloadText: string,
  nowMs: number,
): BeaconRecord | null {
  const paneId = env.HERDR_PANE_ID?.trim() ?? "";
  if (!isPaneId(paneId)) return null;

  const registration = BEACON_HOOKS.find((row) => row.event === event);
  if (registration === undefined) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return null;
  }
  const doc = asObject(payload);
  if (doc === null) return null;

  // A SUBAGENT IS NOT THE PANE. That payload came from a Task running inside the session, and
  // writing its session id would hand the pane a conversation the operator cannot see in it.
  if (doc.agent_id !== undefined && doc.agent_id !== null) return null;

  // Checked by value before anything stringifies it, so `false` and `12` cannot launder into an
  // identifier that then names a file.
  const sessionId = typeof doc.session_id === "string" ? doc.session_id : "";
  if (!SESSION_ID.test(sessionId)) return null;

  const rawName = typeof doc.session_name === "string" ? doc.session_name.trim() : "";
  const sessionName =
    rawName.length > 0 && rawName.length <= MAX_SESSION_NAME && !CONTROL_CHARS.test(rawName)
      ? rawName
      : undefined;

  return {
    schemaVersion: BEACON_SCHEMA_VERSION,
    harness: BEACON_HARNESS,
    paneId,
    session: { kind: "id", value: sessionId },
    status: registration.status,
    heartbeatMs: nowMs,
    ...(sessionName === undefined ? {} : { sessionName }),
  };
}

/**
 * Write one record, atomically: a temp file beside the target, then a rename over it.
 *
 * `renameSync` replaces an existing file on Windows, which is what makes the reader's view atomic —
 * it sees the previous beacon or this one, never half of either.
 */
export function writeBeacon(stateDir: string, record: BeaconRecord): void {
  const fileName = beaconFileName(record.paneId);
  if (fileName === null) return;
  const dir = beaconsDir(stateDir);
  mkdirSync(dir, { recursive: true, mode: BEACON_DIR_MODE });
  const temp = join(dir, `.${fileName}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: BEACON_FILE_MODE });
    renameSync(temp, join(dir, fileName));
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created. Either way there is nothing to report to.
    }
    throw err;
  }
}

/**
 * Read the environment, the event and stdin, and write a beacon if all three agree there is one.
 *
 * Every argv element after the first is IGNORED. The ownership marker is appended to the hook
 * command as a trailing `# sightr-beacon v1`, and `#` starts a comment in `sh` but not in
 * `cmd.exe` — on Windows those three tokens arrive as extra arguments. Ignoring them is what lets
 * one command string work under both shells.
 */
export async function emitBeacon(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  readStdin: () => Promise<string>,
  now: () => number = Date.now,
): Promise<void> {
  // The environment gate again, ahead of the stdin read: outside a Herdr pane this process must
  // touch nothing at all.
  if (!isPaneId(env.HERDR_PANE_ID?.trim() ?? "")) return;
  const record = buildBeaconRecord(argv[0], env, await readStdin(), now());
  if (record === null) return;
  writeBeacon(resolveStateDir(env, homedir()), record);
}

// Guarded, because scripts/ctl/hooks.ts imports BEACON_HOOKS from this module and `bun test` loads
// it. Nothing is printed and the exit is always 0 — see the hazards at the top of the file.
if (import.meta.main) {
  try {
    await emitBeacon(Bun.argv.slice(2), process.env, () => new Response(Bun.stdin).text());
  } catch {
    // A beacon that fails to write is simply absent.
  }
  process.exit(0);
}
