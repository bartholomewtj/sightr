// Structured tool data the journal adapters keep beside a call's one-line summary: the capped
// arguments, a unified diff for an edit, a task list, a plan, a subagent's facts, and a provider
// failure in T3's shape. Shared by the Claude and Pi adapters; pure (no fs, no clock).
//
// WHY CAPS. A log is unbounded (a Write of a 2 MB file, a 500-step todo list), and every item rides
// the thread snapshot. Each item's structured payload is held to about {@link MAX_DETAIL_CHARS}; what
// is cut says so (`truncated`), and the full text stays in the agent's own log.

import type {
  TranscriptError,
  TranscriptTodoStep,
  TranscriptToolDetail,
} from "../../shared/wire.ts";

/** The budget for one tool item's structured payload. */
export const MAX_DETAIL_CHARS = 32_000;
/** The capped JSON of a call's arguments. */
export const MAX_INPUT_CHARS = 8_000;
/** A diff's share of the item budget. */
export const MAX_DIFF_CHARS = 24_000;
/** `oldStr` / `newStr`, kept only when no diff could be built. */
export const MAX_SIDE_CHARS = 4_000;
export const MAX_PLAN_CHARS = MAX_DETAIL_CHARS;
export const MAX_TODO_STEPS = 100;
export const MAX_STEP_CHARS = 500;
export const MAX_PROMPT_CHARS = 4_000;
/** T3's `OrchestrationV2ProviderFailure.message` limit. */
export const MAX_FAILURE_CHARS = 4_096;

// ── Arguments ────────────────────────────────────────────────────────────────────────────────────

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function shrink(value: unknown, maxString: number, maxItems: number, depth = 0): unknown {
  if (typeof value === "string") return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "…";
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxItems).map((v) => shrink(v, maxString, maxItems, depth + 1));
    if (value.length > maxItems) kept.push(`… ${value.length - maxItems} more`);
    return kept;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shrink(v, maxString, maxItems, depth + 1)]),
  );
}

/**
 * A call's arguments, kept whole when their JSON fits {@link MAX_INPUT_CHARS}, else with long strings
 * and arrays cut until it does. Non-object input (none, a bare string) is not kept: the summary has it.
 */
export function capInput(value: unknown): { input?: unknown; inputTruncated?: true } {
  if (value === null || typeof value !== "object") return {};
  if (jsonLength(value) <= MAX_INPUT_CHARS) return { input: value };
  for (const [maxString, maxItems] of [
    [2_000, 50],
    [500, 20],
    [120, 10],
    [40, 5],
  ] as const) {
    const cut = shrink(value, maxString, maxItems);
    if (jsonLength(cut) <= MAX_INPUT_CHARS) return { input: cut, inputTruncated: true };
  }
  return { inputTruncated: true };
}

// ── Diffs ────────────────────────────────────────────────────────────────────────────────────────

/** One hunk as Claude's `structuredPatch` writes it: `lines` carry their ` `/`+`/`-` prefix. */
export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

function isHunk(value: unknown): value is PatchHunk {
  if (value === null || typeof value !== "object") return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h.oldStart === "number" &&
    typeof h.oldLines === "number" &&
    typeof h.newStart === "number" &&
    typeof h.newLines === "number" &&
    Array.isArray(h.lines)
  );
}

/** Claude's `structuredPatch` as a unified diff, or null when the value is not one. */
export function diffFromHunks(fileName: string, hunks: unknown): string | null {
  if (!Array.isArray(hunks) || hunks.length === 0 || !hunks.every(isHunk)) return null;
  const out = [`--- a/${fileName}`, `+++ b/${fileName}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const line of h.lines) if (typeof line === "string") out.push(line);
  }
  return out.join("\n");
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * A replacement of `oldText` by `newText` as one diff hunk: lines both share at the start and end
 * become context, the rest `-` then `+`. Not a minimal diff, but exact for the usual Edit (one
 * contiguous change). The texts are fragments, so the hunk header carries no line numbers.
 */
export function hunkFromStrings(oldText: string, newText: string): string[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const lines = ["@@ @@"];
  for (const l of a.slice(0, head)) lines.push(` ${l}`);
  for (const l of a.slice(head, a.length - tail)) lines.push(`-${l}`);
  for (const l of b.slice(head, b.length - tail)) lines.push(`+${l}`);
  for (const l of a.slice(a.length - tail)) lines.push(` ${l}`);
  return lines;
}

/** Several replacements (MultiEdit, Pi `edit` with `edits[]`) as one diff. */
export function diffFromReplacements(fileName: string, edits: readonly { oldText: string; newText: string }[]): string | null {
  if (edits.length === 0) return null;
  const out = [`--- a/${fileName}`, `+++ b/${fileName}`];
  for (const e of edits) out.push(...hunkFromStrings(e.oldText, e.newText));
  return out.join("\n");
}

/** A whole new file as a diff of additions. */
export function diffForNewFile(fileName: string, content: string): string {
  const lines = splitLines(content);
  return [`--- /dev/null`, `+++ b/${fileName}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
}

/** `+` and `-` lines of a unified diff, headers excluded. */
export function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/** Cut a text at a line end at or before `max` characters. */
export function capAtLine(text: string, max: number): { text: string; truncated?: true } {
  if (text.length <= max) return { text };
  const cut = text.lastIndexOf("\n", max);
  return { text: text.slice(0, cut > 0 ? cut : max), truncated: true };
}

/**
 * A file change's detail: the diff (counted whole, then capped) or, when there is none, the before
 * and after strings (capped).
 */
export function diffDetail(
  fileName: string,
  diff: string | null | undefined,
  sides?: { oldStr?: string; newStr?: string },
): Extract<TranscriptToolDetail, { kind: "diff" }> {
  if (diff) {
    const capped = capAtLine(diff, MAX_DIFF_CHARS);
    return { kind: "diff", fileName, diff: capped.text, ...diffStats(diff), ...(capped.truncated ? { truncated: true } : {}) };
  }
  const detail: Extract<TranscriptToolDetail, { kind: "diff" }> = { kind: "diff", fileName };
  for (const key of ["oldStr", "newStr"] as const) {
    const value = sides?.[key];
    if (typeof value !== "string" || value === "") continue;
    const capped = capAtLine(value, MAX_SIDE_CHARS);
    detail[key] = capped.text;
    if (capped.truncated) detail.truncated = true;
  }
  return detail;
}

// ── Task lists and plans ─────────────────────────────────────────────────────────────────────────

/** A harness task status as T3's step status; null drops the step (Pi `deleted`). */
export function todoStepStatus(raw: unknown): TranscriptTodoStep["status"] | null {
  switch (typeof raw === "string" ? raw.toLowerCase() : "") {
    case "in_progress":
    case "in-progress":
    case "inprogress":
    case "running":
    case "active":
      return "running";
    case "completed":
    case "complete":
    case "done":
      return "completed";
    case "deleted":
    case "removed":
    case "cancelled":
      return null;
    default:
      return "pending";
  }
}

/** A task list, capped to {@link MAX_TODO_STEPS} steps of {@link MAX_STEP_CHARS} characters. */
export function todoDetail(steps: readonly TranscriptTodoStep[]): Extract<TranscriptToolDetail, { kind: "todo" }> {
  const kept = steps
    .slice(0, MAX_TODO_STEPS)
    .map((s) => ({ ...s, text: s.text.length > MAX_STEP_CHARS ? `${s.text.slice(0, MAX_STEP_CHARS)}…` : s.text }));
  const truncated = steps.length > MAX_TODO_STEPS || steps.some((s) => s.text.length > MAX_STEP_CHARS);
  return { kind: "todo", steps: kept, ...(truncated ? { truncated: true } : {}) };
}

export function planDetail(markdown: string): Extract<TranscriptToolDetail, { kind: "plan" }> {
  const capped = capAtLine(markdown, MAX_PLAN_CHARS);
  return { kind: "plan", markdown: capped.text, ...(capped.truncated ? { truncated: true } : {}) };
}

/** A subagent's facts, with the prompt capped. Empty fields are left out. */
export function subagentDetail(fields: {
  agentId?: unknown;
  title?: unknown;
  prompt?: unknown;
  status?: unknown;
  progress?: unknown;
  model?: unknown;
  durationMs?: unknown;
  tokens?: unknown;
  toolUses?: unknown;
}): Extract<TranscriptToolDetail, { kind: "subagent" }> {
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const detail: Extract<TranscriptToolDetail, { kind: "subagent" }> = { kind: "subagent" };
  const agentId = str(fields.agentId);
  if (agentId) detail.agentId = agentId;
  const title = str(fields.title);
  if (title) detail.title = title.length > 200 ? `${title.slice(0, 200)}…` : title;
  const prompt = str(fields.prompt);
  if (prompt) {
    const capped = capAtLine(prompt, MAX_PROMPT_CHARS);
    detail.prompt = capped.text;
    if (capped.truncated) detail.truncated = true;
  }
  const status = str(fields.status);
  if (status) detail.status = status;
  const progress = str(fields.progress);
  if (progress) detail.progress = progress.length > 200 ? `${progress.slice(0, 200)}…` : progress;
  const model = str(fields.model);
  if (model) detail.model = model;
  const durationMs = num(fields.durationMs);
  if (durationMs !== undefined) detail.durationMs = Math.round(durationMs);
  const tokens = typeof fields.tokens === "number" ? num(fields.tokens)?.toString() : str(fields.tokens)?.replace(/\s*tokens?$/i, "");
  if (tokens) detail.tokens = tokens;
  const toolUses = num(fields.toolUses);
  if (toolUses !== undefined) detail.toolUses = toolUses;
  return detail;
}

/** Merge a later, fuller subagent detail (from the result) over the call's. */
export function mergeSubagent(
  base: TranscriptToolDetail | undefined,
  next: Extract<TranscriptToolDetail, { kind: "subagent" }>,
): Extract<TranscriptToolDetail, { kind: "subagent" }> {
  return base?.kind === "subagent" ? { ...base, ...next, ...(base.truncated || next.truncated ? { truncated: true } : {}) } : next;
}

// ── Provider failures ────────────────────────────────────────────────────────────────────────────

const USAGE_LIMIT_RE =
  /hit your [\w\s-]*limit|usage limit|session limit|weekly limit|quota|rate[ _-]?limit|insufficient_quota|out of credits|resets? in \d|too many requests|\b429\b/i;
const TRANSPORT_RE =
  /connection|network|econnreset|etimedout|socket|timed? ?out|went quiet|sent nothing|closed the stream|terminated|overloaded|\b52\d\b|\b503\b|capacity/i;
const PERMISSION_RE = /authentication|unauthori[sz]ed|\b401\b|\b403\b|forbidden|api key|stale .*key|\/login|log in/i;
const VALIDATION_RE = /invalid_request|validation|\b400\b|model_not_found|not_found/i;

export function classifyFailure(message: string, code?: string | null): TranscriptError["class"] {
  const text = `${message} ${code ?? ""}`;
  if (USAGE_LIMIT_RE.test(text)) return "usage_limit";
  if (PERMISSION_RE.test(text)) return "permission_error";
  if (TRANSPORT_RE.test(text)) return "transport_error";
  if (VALIDATION_RE.test(text)) return "validation_error";
  return "provider_error";
}

/**
 * When a usage limit lifts, from the failure text, as epoch ms; null when the text names no time.
 * - "Resets in 1h59m50s" (Pi via thickAPI): `at` plus that duration.
 * - "resets 2:10am", "resets 9am (Australia/Brisbane)" (Claude): the next such wall-clock time after
 *   `at`, in the bridge's own time zone. The named zone is not applied: the bridge runs on the
 *   operator's PC, whose zone is the one Claude prints.
 */
export function parseResetAt(message: string, at: number): number | null {
  const rel = /resets?\s+in\s+((?:\d+\s*[dhms]\s*)+)/i.exec(message);
  if (rel) {
    let ms = 0;
    for (const m of rel[1]!.matchAll(/(\d+)\s*([dhms])/gi)) {
      const n = Number(m[1]);
      ms += n * { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }[m[2]!.toLowerCase() as "d" | "h" | "m" | "s"];
    }
    return ms > 0 ? at + ms : null;
  }
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(message);
  if (clock) {
    let hour = Number(clock[1]) % 12;
    if (clock[3]!.toLowerCase() === "pm") hour += 12;
    const minute = clock[2] ? Number(clock[2]) : 0;
    if (minute > 59) return null;
    const d = new Date(at);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() <= at) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return null;
}

/** A failure in T3's shape. `resetAt` (epoch ms) wins over one parsed from the text. */
export function providerFailure(
  rawMessage: string,
  opts: { code?: string | null; resetAt?: number | null; at: number; usageLimit?: boolean },
): TranscriptError {
  const message = rawMessage.trim().slice(0, MAX_FAILURE_CHARS) || "The provider returned an error.";
  const code = opts.code && opts.code.trim() !== "" ? opts.code.trim().slice(0, 128) : null;
  const cls = opts.usageLimit ? "usage_limit" : classifyFailure(message, code);
  const failure: TranscriptError = { class: cls, message, code, retryable: cls === "transport_error" ? true : null };
  if (cls === "usage_limit") failure.resetAt = opts.resetAt ?? parseResetAt(message, opts.at);
  return failure;
}
