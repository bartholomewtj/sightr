// Match a Grok ask card to the pending `ask_user_question` call.
//
// A 54-column pane paints about two checkbox rows. The rest live in Grok's own card scrollbar, so
// they are not in the Herdr buffer and a screen parse cannot invent them. The journal still has the
// full question. This module decides whether that payload is THIS card. It does not read the pane.

import type { TranscriptAsk, TranscriptAskQuestion, TranscriptEntry } from "../../../../../shared/wire";

export interface AskVisibleOption {
  /** 1-based ordinal. Radio key `1` is 1, `a` is 10. */
  n: number;
  label: string;
}

export interface AskScreenFacts {
  widget: "checkbox" | "radio";
  question: string;
  step: { n: number; m: number } | null;
  visible: AskVisibleOption[];
  /** Gutter rows of the card, joined. Used when the question itself has scrolled away. */
  blob: string;
}

function norm(s: string): string {
  return s.replace(/[…\u2026]|\.\.\./g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Screen text is the catalog text, or a truncated prefix of it (ellipsis, or a cut of 8+ glyphs). */
export function isTruncatedPrefix(screen: string, full: string): boolean {
  const s = norm(screen);
  const f = norm(full);
  if (s === "" || f === "") return false;
  if (s === f) return true;
  if (!f.startsWith(s)) return false;
  if (s.length >= 8) return true;
  return /[…\u2026]|\.\.\./.test(screen) && s.length >= 4;
}

function blobHasSlice(blob: string, text: string): boolean {
  const b = norm(blob);
  const t = norm(text);
  if (t.length < 12 || b === "") return false;
  if (t.length <= 20) return b.includes(t);
  for (let i = 0; i + 20 <= t.length; i += 4) {
    if (b.includes(t.slice(i, i + 20))) return true;
  }
  return false;
}

function mentions(q: TranscriptAskQuestion, facts: AskScreenFacts): boolean {
  if (isTruncatedPrefix(facts.question, q.question)) return true;
  const qn = norm(q.question);
  const sn = norm(facts.question);
  if (sn.length >= 12 && qn.includes(sn)) return true;
  for (const v of facts.visible) {
    const cat = q.options[v.n - 1];
    if (cat && isTruncatedPrefix(v.label, cat.label)) return true;
  }
  if (blobHasSlice(facts.blob, q.question)) return true;
  for (const o of q.options) {
    if (blobHasSlice(facts.blob, o.label)) return true;
    if (o.description && blobHasSlice(facts.blob, o.description)) return true;
  }
  return false;
}

function windowFits(q: TranscriptAskQuestion, visible: AskVisibleOption[]): boolean {
  if (visible.length === 0) return true;
  const ns = visible.map((v) => v.n);
  for (let i = 1; i < ns.length; i++) {
    if (ns[i] !== ns[i - 1]! + 1) return false;
  }
  for (const v of visible) {
    if (v.n < 1 || v.n > q.options.length) return false;
    const cat = q.options[v.n - 1];
    if (!cat || !isTruncatedPrefix(v.label, cat.label)) return false;
  }
  return true;
}

/**
 * The catalog question this card is asking, or null.
 *
 * A step marker must name the same question count as the catalog, and the card must actually
 * mention that question (its text, a visible label, or a 20-glyph slice of a label or description).
 * A visible window must be a contiguous run of that question's options. A gap, a step past the end,
 * or a card that does not mention the question does not match — the screen parse stands.
 */
export function matchAskQuestion(catalog: TranscriptAsk, facts: AskScreenFacts): TranscriptAskQuestion | null {
  const multi = facts.widget === "checkbox";
  if (facts.step && (facts.step.n < 1 || facts.step.n > facts.step.m)) return null;

  let q: TranscriptAskQuestion | undefined;
  if (facts.step) {
    if (facts.step.m !== catalog.questions.length) return null;
    const at = catalog.questions[facts.step.n - 1];
    if (!at || at.multi !== multi) return null;
    q = at;
  } else {
    const pool = catalog.questions.filter((c) => c.multi === multi);
    if (pool.length === 1) q = pool[0];
    else {
      const hits = pool.filter((c) => mentions(c, facts));
      if (hits.length === 1) q = hits[0];
    }
  }
  if (!q) return null;
  if (!mentions(q, facts)) return null;
  if (!windowFits(q, facts.visible)) return null;
  return q;
}

/** Identity that stays put when the card scrolls. The bound region text stays the painted rows. */
export function catalogSignature(
  catalogId: string,
  step: { n: number; m: number } | null,
  question: string,
  labels: string[],
): string {
  return ["grok-ask", catalogId, step ? `${step.n}/${step.m}` : "-", question, ...labels].join("\n");
}

/**
 * The newest unanswered `ask_user_question` in a transcript, or null once it has a result.
 * An older pending call is not used: the card on screen is the latest one.
 */
export function pendingGrokAsk(entries: TranscriptEntry[]): TranscriptAsk | null {
  let found: TranscriptAsk | null = null;
  for (const entry of entries) {
    for (const part of entry.parts) {
      if (part.kind !== "tool" || part.name !== "ask_user_question") continue;
      found = part.result || !part.ask ? null : part.ask;
    }
  }
  return found;
}
