import { lineText, type Block } from "./blocks";
import type { TranscriptEntry } from "./types";

/**
 * Last few sentences, one per line (newest last), or the last 240 characters if there isn't a
 * finished sentence yet. Sentence-splitting stolen from Firelight's pulse.
 */
export function thinkSnip(s: string, sentences = 3): string {
  const t = String(s).replace(/\s+/g, " ").trim();
  const parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length > 1 && /[.!?]$/.test(t)) {
    return parts
      .slice(-sentences)
      .map((part) => part.slice(-160))
      .join("\n");
  }
  return t.slice(-80 * sentences);
}

/** Elapsed thinking time as m:ss. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

/** Tail of the chrome-stripped dump — last few non-blank raw lines, joined. */
export function dumpTail(blocks: Block[], lastLines = 8): string {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.kind !== "raw") continue;
    for (const line of block.lines) {
      const t = lineText(line).replace(/\s+$/g, "");
      if (t.trim() !== "") texts.push(t);
    }
  }
  return texts.slice(-lastLines).join(" ");
}

export const PENDING_USER_UUID = "pending-user";
export const PENDING_STORE_PREFIX = "sightr:pending-user:v1:";
const PENDING_STORE_MAX = 20;

export type PendingUserSend = {
  text: string;
  at: number;
  /** Set when this send happened while the journal had no user turns. */
  opening: boolean;
};

function foldUserText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Spoken text of a user turn, or null. */
export function userSpeech(entry: TranscriptEntry): string | null {
  if (entry.role !== "user") return null;
  const got = entry.parts
    .filter((part): part is Extract<(typeof entry.parts)[number], { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return got === "" ? null : got;
}

/** True when any user turn already carries this send. */
export function journalHasUser(entries: TranscriptEntry[], text: string): boolean {
  const want = foldUserText(text);
  if (want === "") return true;
  return entries.some((entry) => userSpeech(entry) === want);
}

export function journalHasAnyUser(entries: TranscriptEntry[]): boolean {
  return entries.some((entry) => userSpeech(entry) !== null);
}

function pendingTurn(send: PendingUserSend, uuid: string): TranscriptEntry {
  return {
    uuid,
    // Grok journal rows have no timestamp. A clock here would draw a day divider under them.
    ts: "",
    role: "user",
    parts: [{ kind: "text", text: send.text }],
  };
}

/**
 * Pin sends that the jsonl does not have yet. An opening send that never landed (Grok's first
 * prompt is often not the first user_query) sits in front; a follow-up still in flight sits last.
 */
export function mergePendingUsers(
  entries: TranscriptEntry[],
  pending: readonly PendingUserSend[],
): TranscriptEntry[] {
  const still = pending.filter((p) => !journalHasUser(entries, p.text));
  if (still.length === 0) return entries;
  const leading: PendingUserSend[] = [];
  const trailing: PendingUserSend[] = [];
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i]!;
    if (!still.includes(p)) continue;
    const laterLanded = pending.slice(i + 1).some((q) => journalHasUser(entries, q.text));
    if (p.opening || laterLanded) leading.push(p);
    else trailing.push(p);
  }
  const one = leading.length + trailing.length === 1;
  const leadTurns = leading.map((p, i) => pendingTurn(p, one ? PENDING_USER_UUID : `${PENDING_USER_UUID}-lead-${i}`));
  const trailTurns = trailing.map((p, i) => pendingTurn(p, one ? PENDING_USER_UUID : `${PENDING_USER_UUID}-trail-${i}`));
  return [...leadTurns, ...entries, ...trailTurns];
}

export function loadPendingUsers(paneId: string): PendingUserSend[] {
  if (paneId === "" || typeof sessionStorage === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(PENDING_STORE_PREFIX + paneId);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: PendingUserSend[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue;
      const rec = row as { text?: unknown; at?: unknown; opening?: unknown };
      if (typeof rec.text !== "string" || rec.text.trim() === "") continue;
      if (typeof rec.at !== "number" || !Number.isFinite(rec.at)) continue;
      out.push({ text: rec.text, at: rec.at, opening: rec.opening === true });
    }
    return out;
  } catch {
    return [];
  }
}

export function savePendingUsers(paneId: string, pending: readonly PendingUserSend[]): void {
  if (paneId === "" || typeof sessionStorage === "undefined") return;
  const key = PENDING_STORE_PREFIX + paneId;
  if (pending.length === 0) {
    sessionStorage.removeItem(key);
    return;
  }
  sessionStorage.setItem(key, JSON.stringify(pending.slice(-PENDING_STORE_MAX)));
}
