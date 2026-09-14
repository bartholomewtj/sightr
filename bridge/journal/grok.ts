// Grok Build's journal adapter.
//
// SHAPE OF THE SOURCE (verified against ~/.grok/sessions on 2026-08-17, grok 1.0.4):
//   ~/.grok/sessions/<encodeURIComponent(cwd)>/<session-uuid>/chat_history.jsonl
//   {"type":"system","content":"…"}                                              ← identity, dropped
//   {"type":"user","content":[{type:"text",text:"<user_query>…</user_query>"}],
//    "prompt_index":N}
//   {"type":"user","content":[…],"synthetic_reason":"system_reminder"}           ← injected, dropped
//   {"type":"reasoning","id":"rs_…","summary":[{type:"summary_text",text:"…"}]}  ← dropped
//   {"type":"assistant","content":"…","tool_calls":[{id,name,arguments}]}
//   {"type":"tool_result","tool_call_id":"…","content":"…"}
//
// Real user speech is wrapped in <user_query>. The first user row is often the injected
// <user_info> + rules blob; if that same row also carries <user_query>, keep the query.
// synthetic_reason system_reminder rows are skills/MCP reminders and are dropped.
// synthetic_reason interjection rows are a follow-up typed while the model is working — keep them.
// Reasoning rows are the model's private scratch (often encrypted) — the spoken reply is on the
// following assistant row.
//
// Rows have no stable id of their own (except reasoning, which we drop), so the paging cursor is
// synthesised from the row bytes.
//
// HOW THE SESSION IS NAMED. Herdr has no grok integration as of this writing, so a grok pane
// arrives with no agent_session. The adapter therefore also implements inferFromCwd. Logs live
// at `~/.grok/sessions/<encodeURIComponent(cwd)>/<uuid>/`, so every grok tab in one space shares
// a directory — and so do split panes in one tab, and so do subagents the pane spawned. Nothing
// on disk records which pane opened which log, so the pane has to be identified from what it
// shows: its terminal title, and the user turns visible in its viewport.
//
// THE PROBLEM WITH IDENTIFYING A PANE FROM ITS SCREEN is that the screen is not always there.
// Clear the pane, reset it, or start something else in it, and the evidence is gone — while the
// conversation, and the operator's expectation of seeing it, are not. Reading the screen on every
// poll therefore has to be a way to LEARN the binding, not the thing the binding is made of.
//
// So the binding is written down, in `journal/claims.ts`: one pane holds one log, exclusively,
// and the claim survives a cleared pane and a bridge restart alike. Evidence establishes and
// changes a claim; it is never needed to keep one. Because claims are exclusive, "I have no idea"
// can safely answer with the newest log no other pane holds, rather than with nothing — two panes
// can never be handed the same conversation, which is the only thing that answer used to risk.
//
// Evidence is graded (claims.ts): text on screen now (LIVE) outranks the OSC title (TITLE), which
// outranks a positional guess (WEAK). The grading is what makes a new session in an existing pane
// work — the OSC title still names the PREVIOUS session for a while, and title scoring is 1000+
// against a query's length, so without grading the stale title would keep winning.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  CLAIM_LIVE,
  CLAIM_REPORTED,
  CLAIM_TITLE,
  CLAIM_WEAK,
  ClaimStore,
  type ClaimStrength,
} from "./claims.ts";
import { containedRealpath, exists, loadTail, rootList, statFile } from "./files.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
import type {
  AgentSessionRef,
  InferSessionOpts,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOG_NAME = "chat_history.jsonl";
/** This adapter's Herdr `agent` string, and the group claims are recorded under. */
const AGENT = "grok";

export function isGrokSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** Stable per-row cursor. Grok rows carry no id we render, so this is a property of the bytes. */
export function grokCursor(line: string, seen: Map<string, number>): string {
  let hash = 5381;
  for (let i = 0; i < line.length; i++) hash = ((hash << 5) + hash + line.charCodeAt(i)) | 0;
  const key = (hash >>> 0).toString(36);
  const n = seen.get(key) ?? 0;
  seen.set(key, n + 1);
  return n === 0 ? `gx-${key}` : `gx-${key}-${n}`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * Pull the words the operator typed out of a user row. Null means drop the row.
 *
 * Only about a third of user rows are speech: the rest are the injected workspace/rules blob or
 * a synthetic reminder. Rendering those as "You" would be wrong.
 */
export function extractGrokUserSpeech(raw: string): string | null {
  const text = stripAnsi(raw).trim();
  if (text === "") return null;
  // A spoken turn can sit inside the first-row workspace blob (`<user_info>…<user_query>`).
  // Pull the query first so we don't drop the operator's opening message.
  const tagged = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
  if (tagged) {
    const inner = (tagged[1] ?? "").trim();
    return inner === "" ? null : inner;
  }
  if (
    text.startsWith("<user_info>") ||
    text.startsWith("<system-reminder>") ||
    text.startsWith("<rules>") ||
    text.startsWith("<always_applied_workspace_rules")
  ) {
    return null;
  }
  return text;
}

/** Collapse whitespace so a TUI-wrapped user line still matches the journal query. */
export function foldGrokHint(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Last spoken user turns in a Grok log, newest first. Walks from the end so a tail-read
 * (partial first line) still yields the queries on screen now.
 */
export function lastGrokUserQueries(text: string, n = 3): string[] {
  const found: string[] = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && found.length < n; i--) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    let row: GrokRow;
    try {
      row = JSON.parse(line) as GrokRow;
    } catch {
      continue;
    }
    if (row.type !== "user") continue;
    // Reminders are not speech. Interjections are — a follow-up typed while the model is working.
    if (typeof row.synthetic_reason === "string" && row.synthetic_reason !== "interjection") continue;
    const speech = extractGrokUserSpeech(contentText(row.content));
    if (speech !== null) found.push(speech);
  }
  return found;
}

const MIN_TITLE_CHARS = 8;
const MIN_QUERY_CHARS = 12;
const QUERY_PREFIX_CHARS = 80;
/** OSC titles Herdr reports are often cut with `…` and suffixed ` - grok`. */
const TITLE_ELLIPSIS = /…|\.{3}/;
const GROK_TITLE_SUFFIX = /\s+-\s+grok\b/g;
/** Live composer / last user line in a Grok dump (`>` from `pane.read` text, `❯` in the TUI). */
const PROMPT_LINE = /^\s*[>❯]\s+(.+)$/;
const TRAILING_CLOCK = /\s+\d{1,2}:\d{2}(?:\s*[AaPp][Mm])?\s*$/;

/**
 * The live `> query` line from a raw (not folded) pane hint. Last matching line wins.
 * Trailing `3:31 PM` clocks from the dump are stripped. Null when no line is long enough
 * to fingerprint — an empty composer is not a query.
 */
export function liveGrokPrompt(hint: string): string | null {
  let best: string | null = null;
  for (const line of hint.split(/\r?\n/)) {
    const m = PROMPT_LINE.exec(line);
    if (!m) continue;
    const body = foldGrokHint((m[1] ?? "").replace(TRAILING_CLOCK, ""));
    if (body.length >= MIN_QUERY_CHARS) best = body;
  }
  return best;
}

/**
 * Title fragments from a live hint after OSC truncation. "Foo bar baz… - grok" yields
 * "foo bar baz", which is a prefix of the session's generated_title rather than a substring of
 * the hint — `foldedHint.includes(fullTitle)` misses those.
 */
export function truncatedTitlePrefixes(foldedHint: string): string[] {
  const cleaned = foldGrokHint(foldedHint.replace(GROK_TITLE_SUFFIX, " "));
  const out: string[] = [];
  for (const raw of cleaned.split(TITLE_ELLIPSIS)) {
    const p = raw.trim().replace(/^[-|]+\s*|\s*[-|]+$/g, "").trim();
    if (p.length >= MIN_TITLE_CHARS) out.push(p);
  }
  return out;
}

/**
 * True when this spoken user turn is in the live hint. Full match, the leading 80 chars of a
 * long query (TUI wrap / a 120-line viewport clip), or a clipped `> query` line that is a
 * prefix of the turn (phone-width dump). Same bar as the query half of scoreGrokHint.
 */
export function grokHintHasQuery(
  foldedHint: string,
  query: string,
  livePrompt?: string | null,
): boolean {
  const f = foldGrokHint(query);
  if (f.length < MIN_QUERY_CHARS) return false;
  if (foldedHint.includes(f)) return true;
  if (f.length >= 24 && foldedHint.includes(f.slice(0, QUERY_PREFIX_CHARS))) return true;
  if (livePrompt && livePrompt.length >= MIN_QUERY_CHARS && f.startsWith(livePrompt)) return true;
  return false;
}

/** How well a live pane hint (viewport + title) matches a session's title and last user turns. */
export function scoreGrokHint(
  foldedHint: string,
  title: string | null,
  queries: string[],
  livePrompt?: string | null,
): number {
  if (foldedHint === "") return 0;
  let score = 0;
  if (title) {
    const t = foldGrokHint(title);
    if (t.length >= MIN_TITLE_CHARS && foldedHint.includes(t)) {
      score += 1000 + t.length;
    } else if (t.length >= MIN_TITLE_CHARS) {
      let best = 0;
      for (const p of truncatedTitlePrefixes(foldedHint)) {
        if (t.startsWith(p) && p.length > best) best = p.length;
      }
      if (best >= MIN_TITLE_CHARS) score += 1000 + best;
    }
  }
  for (const q of queries) {
    if (!grokHintHasQuery(foldedHint, q, livePrompt)) continue;
    const f = foldGrokHint(q);
    score +=
      f.length >= MIN_QUERY_CHARS && foldedHint.includes(f)
        ? f.length
        : Math.min(QUERY_PREFIX_CHARS, f.length);
  }
  return score;
}

function parseToolArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { command: raw };
  }
}

interface GrokRow {
  type?: unknown;
  content?: unknown;
  synthetic_reason?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
}

/**
 * Parse a Grok chat_history.jsonl into oldest-first turns. PURE — no fs, no clock.
 *
 * Unparseable lines are skipped: the log is appended to live, so the last line can be a partial
 * write, and a tail-read window starts mid-line by construction.
 */
export function parseGrokTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const pendingTools = new Map<string, Extract<TranscriptPart, { kind: "tool" }>>();
  const seen = new Map<string, number>();

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: GrokRow;
    try {
      row = JSON.parse(line) as GrokRow;
    } catch {
      continue;
    }
    const uuid = grokCursor(line, seen);

    if (row.type === "user") {
      if (typeof row.synthetic_reason === "string" && row.synthetic_reason !== "interjection") continue;
      const speech = extractGrokUserSpeech(contentText(row.content));
      if (speech === null) continue;
      entries.push({
        uuid,
        ts: "",
        role: "user",
        parts: [{ kind: "text", ...clamp(speech, MAX_TEXT_CHARS) }],
      });
      continue;
    }

    if (row.type === "assistant") {
      const parts: TranscriptPart[] = [];
      const spoken = stripAnsi(typeof row.content === "string" ? row.content : contentText(row.content));
      if (spoken.trim() !== "") parts.push({ kind: "text", ...clamp(spoken, MAX_TEXT_CHARS) });
      if (Array.isArray(row.tool_calls)) {
        for (const raw of row.tool_calls) {
          if (!raw || typeof raw !== "object") continue;
          const tc = raw as { id?: unknown; name?: unknown; arguments?: unknown };
          const name = typeof tc.name === "string" ? tc.name : "tool";
          const part: Extract<TranscriptPart, { kind: "tool" }> = {
            kind: "tool",
            name,
            summary: summarizeToolInput(parseToolArgs(tc.arguments)),
          };
          parts.push(part);
          if (typeof tc.id === "string" && tc.id !== "") pendingTools.set(tc.id, part);
        }
      }
      if (parts.length === 0) continue;
      entries.push({ uuid, ts: "", role: "assistant", parts });
      continue;
    }

    if (row.type === "tool_result") {
      const id = typeof row.tool_call_id === "string" ? row.tool_call_id : "";
      const resultText = stripAnsi(contentText(row.content));
      const target = pendingTools.get(id);
      if (target) {
        pendingTools.delete(id);
        target.result = clamp(resultText, MAX_RESULT_CHARS);
      } else if (resultText.trim() !== "") {
        entries.push({
          uuid,
          ts: "",
          role: "assistant",
          parts: [{ kind: "tool", name: "tool", summary: "", result: clamp(resultText, MAX_RESULT_CHARS) }],
        });
      }
    }
  }
  return entries;
}

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export class GrokTranscriptSource implements TranscriptSource {
  private readonly pathCache = new Map<string, string>();
  private readonly roots: string[];
  private readonly claims: ClaimStore;

  /** `claimFile` is where bindings are remembered; null keeps them in memory (tests). */
  constructor(roots: string | readonly string[], claimFile: string | null = null) {
    this.roots = rootList(roots);
    this.claims = new ClaimStore(claimFile);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind === "path") {
      const candidate = ref.value.endsWith(LOG_NAME) ? ref.value : join(ref.value, LOG_NAME);
      for (const root of this.roots) {
        const real = await containedRealpath(candidate, root);
        if (real !== null) return real;
      }
      return null;
    }
    if (!isGrokSessionId(ref.value)) return null;
    const sessionId = ref.value;
    const cached = this.pathCache.get(sessionId);
    if (cached !== undefined) {
      if (await exists(cached)) return cached;
      this.pathCache.delete(sessionId);
    }

    for (const root of this.roots) {
      let cwdDirs: string[];
      try {
        cwdDirs = await readdir(root);
      } catch {
        continue;
      }
      for (const dir of cwdDirs) {
        const candidate = join(root, dir, sessionId, LOG_NAME);
        if (!(await exists(candidate))) continue;
        const real = await containedRealpath(candidate, root);
        if (real === null) break;
        this.pathCache.set(sessionId, real);
        return real;
      }
    }
    return null;
  }

  /**
   * Pick the session for a grok pane when Herdr named none.
   *
   * One rule, applied in order, for every pane whether or not it has siblings:
   *
   *   1. EVIDENCE. If the pane is showing something, read it. A user turn visible on screen binds
   *      LIVE; the OSC terminal title binds TITLE. Evidence takes a log away from another pane
   *      only when it is at least as strong as that pane's claim.
   *   2. WHAT HERDR REPORTS, if it names a log that exists here. Above a guess, below the screen:
   *      Herdr's grok integration does not follow a new session opened in an existing pane.
   *   3. THIS PANE'S STANDING CLAIM. A cleared, reset or scrolled-away pane produces no evidence,
   *      and that is not a reason to forget which conversation is its own. The claim is on disk,
   *      so this survives a bridge restart too.
   *   3. THE NEWEST LOG NO OTHER PANE HOLDS, bound WEAK. A guess, but a safe and stable one:
   *      exclusivity means it can never duplicate a sibling's conversation, and the first frame
   *      of real evidence upgrades or corrects it.
   *
   * Only when every log at this cwd is already spoken for by another pane is the answer nothing.
   *
   * Subagent sessions share the cwd folder and are often the newest thing in it; they are excluded
   * from the candidate pool everywhere, so they can be neither matched nor guessed into.
   */
  async inferFromCwd(cwdOrOpts: string | InferSessionOpts): Promise<AgentSessionRef | null> {
    const opts: InferSessionOpts = typeof cwdOrOpts === "string" ? { cwd: cwdOrOpts } : cwdOrOpts;
    if (opts.cwd.trim() === "") return null;
    const want = normalizeCwd(opts.cwd);
    for (const root of this.roots) {
      const sessionDir = await this.cwdDir(root, opts.cwd, want);
      if (sessionDir === null) continue;
      const listed = await listSessionIds(sessionDir);
      if (listed.length === 0) continue;
      const pool = await primarySessions(sessionDir, listed);
      if (pool.length === 0) continue;

      // The bare-string form remembers nothing — it has no pane to remember anything against.
      const paneId = opts.paneId;
      if (paneId === undefined) return { kind: "id", value: pool[0]!.id };

      await this.claims.ready();
      // Let go of logs that no longer exist, and of panes that no longer run grok here, before
      // either can reserve a candidate against a pane that is actually live.
      this.claims.dropMissingSessions(AGENT, want, new Set(pool.map((s) => s.id)));
      if (opts.peerPaneIds !== undefined) {
        this.claims.keepOnlyPanes(AGENT, want, new Set(opts.peerPaneIds));
      }

      const folded = opts.hint ? foldGrokHint(opts.hint) : "";
      if (folded !== "") {
        const mine = this.claims.claimOf(AGENT, want, paneId);
        const found = await this.readEvidence(
          sessionDir,
          pool,
          folded,
          liveGrokPrompt(opts.hint!),
          (id) => {
            const owner = this.claims.ownerOf(AGENT, want, id);
            return owner !== undefined && owner.paneId !== paneId;
          },
          mine?.sessionId,
        );
        if (found !== null && this.claims.set(AGENT, want, paneId, found.id, found.strength)) {
          return { kind: "id", value: found.id };
        }
      }

      // What Herdr says, if it is a real candidate here. Below the screen and above a guess: it
      // goes stale when a pane opens a new session, so `set` will refuse it whenever this pane has
      // already been placed by stronger evidence.
      const reported = opts.reportedSessionId;
      if (reported !== undefined && pool.some((s) => s.id === reported)) {
        if (this.claims.set(AGENT, want, paneId, reported, CLAIM_REPORTED)) {
          return { kind: "id", value: reported };
        }
      }

      const held = this.claims.claimOf(AGENT, want, paneId);
      if (held !== undefined) return { kind: "id", value: held.sessionId };

      const free = pool.find((s) => {
        const owner = this.claims.ownerOf(AGENT, want, s.id);
        return owner === undefined || owner.paneId === paneId;
      });
      if (free !== undefined) {
        this.claims.set(AGENT, want, paneId, free.id, CLAIM_WEAK);
        return { kind: "id", value: free.id };
      }
      return null;
    }
    return null;
  }

  /** Flush remembered claims to disk. For tests and for a clean shutdown. */
  async flushClaims(): Promise<void> {
    await this.claims.flush();
  }

  /** The claims this source is holding. Test and diagnostics seam. */
  claimRows(): ReturnType<ClaimStore["all"]> {
    return this.claims.all();
  }

  /**
   * What the pane's screen says about which log is its own, or null when it says nothing usable.
   *
   * `mineId` is this pane's standing claim. It is always fingerprinted, even when it has aged out
   * of the newest FINGERPRINT_SESSIONS — a pane sitting on a long-running older conversation must
   * still be able to re-confirm it from its own screen.
   */
  private async readEvidence(
    sessionDir: string,
    pool: { id: string; mtimeMs: number }[],
    folded: string,
    livePrompt: string | null,
    heldByAnother: (sessionId: string) => boolean,
    mineId?: string,
  ): Promise<{ id: string; strength: ClaimStrength } | null> {
    const ids = new Set<string>();
    if (mineId !== undefined && pool.some((s) => s.id === mineId)) ids.add(mineId);
    for (const s of pool) {
      if (ids.size >= FINGERPRINT_SESSIONS) break;
      ids.add(s.id);
    }
    const ranked = await this.scoreSessions(
      sessionDir,
      pool.filter((s) => ids.has(s.id)),
      folded,
      livePrompt,
    );

    // A user turn on screen right now is the strongest thing we can know. Prefer the pane's NEWEST
    // turn (what it is doing) to any of its last three (what it has merely scrolled to).
    const newestHits = ranked.filter((r) => r.newestQuery);
    if (newestHits.length === 1) return { id: newestHits[0]!.id, strength: CLAIM_LIVE };
    const anyHits = ranked.filter((r) => r.anyQuery);
    if (anyHits.length === 1) return { id: anyHits[0]!.id, strength: CLAIM_LIVE };

    const byTitle = uniqueBest(ranked);

    // A prompt on screen that no candidate log contains usually means the pane has just started a
    // NEW session whose first turn is not written yet. Take the newest candidate, LIVE, so the
    // previous session's OSC title cannot pull the pane back (that is the 0.113.1 case).
    //
    // But "newest log at this cwd" is only this pane's new session if it is not already somebody
    // else's. A pane merely waiting on a reply produces the same empty match, and without these
    // two guards it was handed whichever neighbour had written most recently — which is exactly
    // how a pane showing "Organize CT docs" ended up serving the "Firelight extensibility" chat.
    // So: skip logs another pane holds, and require something NEWER than this pane's own claim.
    if (livePrompt !== null && !ranked.some((r) => r.newestQuery || r.anyQuery)) {
      const mineMtime = pool.find((s) => s.id === mineId)?.mtimeMs;
      const fresh = pool.find(
        (s) =>
          ids.has(s.id) &&
          !heldByAnother(s.id) &&
          (mineMtime === undefined || s.mtimeMs > mineMtime),
      );
      if (fresh !== undefined) return { id: fresh.id, strength: CLAIM_LIVE };
    }

    return byTitle === null ? null : { id: byTitle, strength: CLAIM_TITLE };
  }

  private async scoreSessions(
    sessionDir: string,
    listed: { id: string; mtimeMs: number }[],
    foldedHint: string,
    livePrompt: string | null,
  ): Promise<{ id: string; score: number; newestQuery: boolean; anyQuery: boolean }[]> {
    const out: { id: string; score: number; newestQuery: boolean; anyQuery: boolean }[] = [];
    for (const s of listed) {
      const title = await grokGeneratedTitle(sessionDir, s.id);
      const tail = await grokLogTail(sessionDir, s.id);
      const queries = tail === null ? [] : lastGrokUserQueries(tail, 3);
      const newest = queries[0];
      out.push({
        id: s.id,
        score: scoreGrokHint(foldedHint, title, queries, livePrompt),
        newestQuery: newest !== undefined && grokHintHasQuery(foldedHint, newest, livePrompt),
        anyQuery: queries.some((q) => grokHintHasQuery(foldedHint, q, livePrompt)),
      });
    }
    return out;
  }

  private async cwdDir(root: string, cwd: string, want: string): Promise<string | null> {
    const exact = join(root, encodeURIComponent(cwd));
    if (await exists(exact)) {
      const real = await containedRealpath(exact, root);
      if (real !== null) return real;
    }
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return null;
    }
    for (const name of names) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(name);
      } catch {
        continue;
      }
      if (normalizeCwd(decoded) !== want) continue;
      const real = await containedRealpath(join(root, name), root);
      if (real !== null) return real;
    }
    return null;
  }

  stat = statFile;
  load = loadTail;
}

/** How many of the newest sessions we fingerprint against a live pane. */
const FINGERPRINT_SESSIONS = 16;
/** Bytes of chat_history.jsonl we read from the end to recover the last user turns. */
const FINGERPRINT_TAIL_BYTES = 64 * 1024;

async function listSessionIds(sessionDir: string): Promise<{ id: string; mtimeMs: number }[]> {
  let names: string[];
  try {
    names = await readdir(sessionDir);
  } catch {
    return [];
  }
  const out: { id: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!isGrokSessionId(name)) continue;
    const log = join(sessionDir, name, LOG_NAME);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(log);
    } catch {
      continue;
    }
    out.push({ id: name, mtimeMs: st.mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  return out;
}

async function grokSummary(
  sessionDir: string,
  id: string,
): Promise<{ generated_title?: unknown; session_kind?: unknown } | null> {
  const candidate = join(sessionDir, id, "summary.json");
  const real = await containedRealpath(candidate, sessionDir);
  if (real === null) return null;
  try {
    const parsed = JSON.parse(await Bun.file(real).text()) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as { generated_title?: unknown; session_kind?: unknown })
      : null;
  } catch {
    return null;
  }
}

async function isGrokSubagent(sessionDir: string, id: string): Promise<boolean> {
  const summary = await grokSummary(sessionDir, id);
  return summary?.session_kind === "subagent";
}

/**
 * The sessions a pane could plausibly be on, newest first: primaries only.
 *
 * Subagent logs live in the same cwd folder and are frequently the newest thing in it, so leaving
 * them in the pool would let one be matched, guessed into, or claimed. Filtering once here is what
 * lets every later step treat "the pool" as simply "the candidates". When a folder holds nothing
 * but subagent logs the pool is empty and the caller moves on to the next root.
 */
async function primarySessions(
  sessionDir: string,
  listed: { id: string; mtimeMs: number }[],
): Promise<{ id: string; mtimeMs: number }[]> {
  const out: { id: string; mtimeMs: number }[] = [];
  for (const s of listed) {
    if (!(await isGrokSubagent(sessionDir, s.id))) out.push(s);
  }
  return out;
}

async function grokGeneratedTitle(sessionDir: string, id: string): Promise<string | null> {
  const title = (await grokSummary(sessionDir, id))?.generated_title;
  return typeof title === "string" && title.trim() !== "" ? title.trim() : null;
}

async function grokLogTail(sessionDir: string, id: string): Promise<string | null> {
  const candidate = join(sessionDir, id, LOG_NAME);
  const real = await containedRealpath(candidate, sessionDir);
  if (real === null) return null;
  try {
    const file = Bun.file(real);
    const size = file.size;
    return size <= FINGERPRINT_TAIL_BYTES
      ? await file.text()
      : await file.slice(size - FINGERPRINT_TAIL_BYTES).text();
  } catch {
    return null;
  }
}

function uniqueBest(ranked: { id: string; score: number }[]): string | null {
  let best: { id: string; score: number } | null = null;
  let tied = false;
  for (const r of ranked) {
    if (r.score <= 0) continue;
    if (best === null || r.score > best.score) {
      best = r;
      tied = false;
    } else if (r.score === best.score && r.id !== best.id) {
      tied = true;
    }
  }
  return best !== null && !tied ? best.id : null;
}

/**
 * Grok's journal adapter. `agent` matches the Herdr snapshot's `agent` string.
 *
 * `claimFile` is where pane→session bindings are remembered across restarts; null keeps them in
 * memory, which is what a build with no state directory (and every unit test) gets.
 */
export function grokJournal(
  roots: string | readonly string[],
  claimFile: string | null = null,
): JournalAdapter {
  const source = new GrokTranscriptSource(roots, claimFile);
  return {
    agent: AGENT,
    source,
    parse: parseGrokTranscript,
    inferFromCwd: (cwd) => source.inferFromCwd(cwd),
  };
}
