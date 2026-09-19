export type MarkerParseResult =
  | { kind: "found"; thread: string; run: string }
  | { kind: "refused"; reason: string }
  | { kind: "none" };

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RUN_RE = /^[0-9a-fA-F]{8}$/;

/**
 * Parses a single line for the draftr operator-decision marker:
 * `whistlr.decision thread=<uuid> run=<8hex>`
 */
export function parseDecisionMarkerLine(line: string): MarkerParseResult {
  // Strip leading box-drawing/gutter characters (e.g. Grok's │ or ┃)
  const clean = line.trim().replace(/^[┃│║]\s*/, "").trim();

  // If it doesn't contain whistlr.decision, it is not a decision card (unmarked)
  if (!clean.includes("whistlr.decision")) {
    return { kind: "none" };
  }

  const tokens = clean.split(/\s+/);
  // Full match on one line: must start with whistlr.decision
  if (tokens[0] !== "whistlr.decision") {
    // extra tokens before whistlr.decision break the line -> not marked
    return { kind: "none" };
  }

  let threadToken: string | undefined;
  let runToken: string | undefined;
  let hasExtra = false;

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("thread=")) {
      if (threadToken !== undefined) hasExtra = true;
      threadToken = tok;
    } else if (tok.startsWith("run=")) {
      if (runToken !== undefined) hasExtra = true;
      runToken = tok;
    } else {
      hasExtra = true;
    }
  }

  // Extra tokens that break the line -> not a marked card (unmarked key path)
  if (hasExtra) {
    return { kind: "none" };
  }

  // Check thread token
  if (!threadToken) {
    // Missing thread id -> parse refuses (no spawn, no keys)
    return { kind: "refused", reason: "missing thread id" };
  }

  const threadVal = threadToken.slice("thread=".length);
  if (!UUID_RE.test(threadVal)) {
    // Truncated / invalid thread id -> parse refuses
    return { kind: "refused", reason: "truncated or invalid thread id" };
  }

  // Check run token
  if (!runToken) {
    // Missing run -> not a marked card (unmarked key path)
    return { kind: "none" };
  }

  const runVal = runToken.slice("run=".length);
  if (!RUN_RE.test(runVal)) {
    // Missing / invalid run -> not a marked card (unmarked key path)
    return { kind: "none" };
  }

  return {
    kind: "found",
    thread: threadVal.toLowerCase(),
    run: runVal.toLowerCase(),
  };
}

/**
 * Scans lines or text for the decision marker.
 * Returns found if a valid marker line exists,
 * refused if any line attempts a marker with truncated/missing thread id,
 * or none.
 */
export function parseDecisionMarker(text: string | string[]): MarkerParseResult {
  const lines = Array.isArray(text) ? text : text.split(/\r?\n/);
  let refusedResult: MarkerParseResult | null = null;

  for (const line of lines) {
    const res = parseDecisionMarkerLine(line);
    if (res.kind === "found") {
      return res;
    }
    if (res.kind === "refused" && !refusedResult) {
      refusedResult = res;
    }
  }

  return refusedResult ?? { kind: "none" };
}
