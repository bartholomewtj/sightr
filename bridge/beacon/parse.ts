import type { AgentSessionRef } from "../journal/types.ts";
import { isPaneId } from "./paths.ts";
import { BEACON_SCHEMA_VERSION, BEACON_STATUSES, type BeaconRecord, type BeaconStatus } from "./types.ts";

// THE PARSE BOUNDARY. Every field read of an on-disk beacon happens here and nowhere else, and this
// function is TOTAL OVER GARBAGE: there is no input for which it throws. A torn write is the
// ordinary case, not an exception — the emitter renames a temp file over the target, but a file
// someone else put in the directory has no such discipline.
//
// VALIDATION IS NOT TRUST. Nothing here decides a value is safe to ACT on; it decides the record is
// well-formed enough to be a hint. The session ref it yields still reaches the filesystem only
// through the containment in ../journal/files.ts.

/** The longest a bounded string field may be. Generous — the point is a ceiling, not a shape. */
const MAX_FIELD = 4096;
/** A display name is read by a human on a phone; anything longer is not a name. */
const MAX_SESSION_NAME = 200;
/** Control characters have no place in a name that lands in the herd list. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A non-empty trimmed string no longer than `max`, or null. */
function readText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/** A finite, non-negative number, or null. `Infinity` (what `1e999` parses to) is not one. */
function readTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function readSession(value: unknown): AgentSessionRef | null {
  const obj = readObject(value);
  if (obj === null) return null;
  const kind = obj.kind;
  if (kind !== "id" && kind !== "path") return null;
  const refValue = readText(obj.value, MAX_FIELD);
  if (refValue === null) return null;
  return { kind, value: refValue };
}

function readStatus(value: unknown): BeaconStatus | null {
  return typeof value === "string" && (BEACON_STATUSES as readonly string[]).includes(value)
    ? (value as BeaconStatus)
    : null;
}

/**
 * A beacon record parsed out of one file's text, or null when the text is not one.
 *
 * The schema check is EXACT, not a floor: a newer version is skipped rather than guessed at, because
 * a version we do not know may mean a field we DO know differently, and a misread identity is worse
 * than an absent one.
 *
 * A malformed `sessionName` drops the FIELD, not the record — a name is the one field whose absence
 * costs nothing (the pane falls back to the name read off the screen), so refusing the whole record
 * over it would throw away a good session ref for a cosmetic reason.
 */
export function parseBeacon(text: string): BeaconRecord | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }

  const doc = readObject(decoded);
  if (doc === null) return null;
  if (doc.schemaVersion !== BEACON_SCHEMA_VERSION) return null;

  const harness = readText(doc.harness, MAX_FIELD);
  if (harness === null) return null;

  const paneId = typeof doc.paneId === "string" && isPaneId(doc.paneId) ? doc.paneId : null;
  if (paneId === null) return null;

  const session = readSession(doc.session);
  if (session === null) return null;

  const status = readStatus(doc.status);
  if (status === null) return null;

  const heartbeatMs = readTimestamp(doc.heartbeatMs);
  if (heartbeatMs === null) return null;

  const name = readText(doc.sessionName, MAX_SESSION_NAME);
  const sessionName = name !== null && !CONTROL_CHARS.test(name) ? name : undefined;

  return {
    schemaVersion: BEACON_SCHEMA_VERSION,
    harness,
    paneId,
    session,
    status,
    heartbeatMs,
    ...(sessionName === undefined ? {} : { sessionName }),
  };
}
