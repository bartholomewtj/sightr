import type { Config } from "./config.ts";
import type { HerdrClient, PaneRead } from "./herdr-client.ts";
import { computeEtag, gzipJsonResponse, notModified } from "./http-cache.ts";
import { adapterFor } from "./journal/registry.ts";
import type { JournalAdapter } from "./journal/types.ts";
import { TranscriptStore } from "./journal/store.ts";
import type { PaneHistoryResponse, PaneReadResponse } from "../shared/wire.ts";
import type { AgentView } from "./state-engine.ts";
import type { StateEngine } from "./state-engine.ts";
import { buildId, withBuildHeader } from "./static-assets.ts";
import { failureText, json, secure, text } from "./responses.ts";
import { effectiveSettings } from "./runtime-settings.ts";

const MAX_READ_LINES = 10_000;
const DEFAULT_HISTORY_LIMIT = 200;
const MAX_HISTORY_LIMIT = 5000;
/** Shell/TUI panes (draftr run tab, win-terminal-browser, …) only need the viewport. */
export const SHELL_MIRROR_LINES_CAP = 120;

/** How to read a pane mirror. Shell panes use `visible` so Herdr never scroll-harvests scrollback. */
export function paneReadSpec(
  pane: AgentView | undefined,
  requestedLines: number,
): { source: "visible" | "recent"; lines: number } {
  if (pane?.kind === "shell") {
    return {
      source: "visible",
      lines: Math.min(requestedLines, SHELL_MIRROR_LINES_CAP),
    };
  }
  return { source: "recent", lines: requestedLines };
}

function paneForRead(engine: StateEngine | undefined, paneId: string): AgentView | undefined {
  if (!engine) return undefined;
  const { agents, shellPanes } = engine.current();
  return shellPanes.find((p) => p.paneId === paneId) ?? agents.find((p) => p.paneId === paneId);
}

export async function readPane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  url: URL,
  req: Request,
  engine?: StateEngine,
): Promise<Response> {
  const linesParam = Number.parseInt(url.searchParams.get("lines") ?? "", 10);
  // Clamp to a sane ceiling — don't trust the client (or Herdr) to bound an enormous read.
  const lines =
    Number.isFinite(linesParam) && linesParam > 0
      ? Math.min(linesParam, MAX_READ_LINES)
      : effectiveSettings(cfg).readLines;
  const { source, lines: readLines } = paneReadSpec(paneForRead(engine, paneId), lines);
  try {
    // "ansi" so the client can render a faithful, colored terminal mirror. Agent panes use `recent`
    // for scrollback; shell/TUI panes use `visible` (see paneReadSpec) so a phone poll never drives
    // Herdr's scroll harvester — which can take many seconds on a draftr run tab. HERDR_API.md →
    // `pane.read`.
    const read = await herdr.readPane(paneId, source, readLines, "ansi");
    const data = paneReadResponse(paneId, read);
    // ETag is derived from the serialised body — if content hasn't changed the client gets a 304
    // and skips the whole transfer (the big win on a cellular link).
    const bodyStr = JSON.stringify(data);
    const etag = computeEtag(bodyStr);
    // Tag pane polls too (both the 304 and the full body), so a client that only has a pane open —
    // not the home snapshot — still observes a live rebuild between polls.
    const build = await buildId();
    if (notModified(req.headers.get("if-none-match"), etag)) {
      // RFC 7232 §4.1: 304 MUST echo the ETag; body MUST be empty.
      return withBuildHeader(
        secure(
          new Response(null, {
            status: 304,
            headers: { etag, "cache-control": "no-store" },
          }),
        ),
        build,
      );
    }
    return withBuildHeader(
      secure(gzipJsonResponse(data, req.headers.get("accept-encoding"), { etag })),
      build,
    );
  } catch (err) {
    return text(failureText("herdr read", err), 502);
  }
}

/**
 * Map a Herdr pane read to the REST response body. Pure + exported so the `revision` passthrough
 * (the client's prompt-select race guard depends on it) is covered by the bridge unit tests without
 * standing up Bun.serve / the socket client.
 */
export function paneReadResponse(paneId: string, read: PaneRead): PaneReadResponse {
  return { paneId, text: read.text, truncated: read.truncated, revision: read.revision };
}

/**
 * Parse the history page params. Pure + exported so the clamping is unit-tested without Bun.serve.
 * `before` is an opaque cursor (a turn's uuid) that only ever reaches an in-memory `findIndex`, so it
 * needs no validation beyond length — it never touches the filesystem.
 */
export function historyParams(url: URL): { limit: number; before?: string } {
  const raw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_HISTORY_LIMIT) : DEFAULT_HISTORY_LIMIT;
  const before = url.searchParams.get("before");
  return { limit, ...(before && before.length <= 100 ? { before } : {}) };
}

/** Fold a pane cwd so `C:\foo`, `C:/foo/` and `c:\Foo` count as the same grok session directory. */
export function foldCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function agentCwdKey(pane: { agent: string; cwd: string }): string {
  return `${pane.agent}\0${foldCwd(pane.cwd)}`;
}

/**
 * Every live pane running the same agent in the same directory as `pane`, including `pane` itself.
 *
 * The adapter needs the whole set, not just a count: a pane that has closed or switched harness
 * must have its claim on a log released, or it would reserve that log against the panes that are
 * still there (journal/claims.ts).
 */
export function panePeersAtCwd(
  agents: AgentView[],
  shellPanes: AgentView[],
  pane: AgentView,
): string[] {
  if (pane.cwd === "") return [pane.paneId];
  const key = agentCwdKey(pane);
  return [...agents, ...shellPanes]
    .filter((p) => p.cwd !== "" && agentCwdKey(p) === key)
    .map((p) => p.paneId);
}

/**
 * Live text the adapter reads THIS pane's identity out of, when it can.
 *
 * Best effort by design: a cleared or reset pane returns nothing here, and that is fine — the
 * adapter falls back to the binding it already recorded rather than to a blank history.
 *
 * `visible` + `text` — never `recent`. A `recent` read of a pane on the alt screen can scroll the
 * operator's terminal (HERDR_API.md); history is on-demand but still must not move their screen.
 */
async function paneHistoryHint(herdr: HerdrClient, pane: AgentView): Promise<string | undefined> {
  const parts: string[] = [];
  if (pane.terminalTitle) parts.push(pane.terminalTitle);
  if (typeof herdr.readPane !== "function") {
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  try {
    const lines =
      pane.readableLines !== undefined && pane.readableLines > 0
        ? Math.min(pane.readableLines, 120)
        : 80;
    const read = await herdr.readPane(pane.paneId, "visible", lines, "text");
    if (read.text.trim() !== "") parts.push(read.text);
  } catch {
    // Best-effort: title / a remembered bind still work if the read fails.
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * GET /api/pane/:id/history — the conversation history the pane's terminal cannot provide.
 *
 * The session ref is resolved HERE, from the live snapshot, keyed by pane id — the client never sends
 * one. That is the whole safety story for a route that reads files: the only client-controlled inputs
 * are a pane id (a Map lookup) and an opaque cursor (an array lookup). Which harness knows how to
 * read the log is the registry's decision, so this route stays agent-agnostic.
 */
export async function paneHistory(
  cfg: Config,
  journals: Record<string, JournalAdapter> | null,
  transcripts: TranscriptStore | null,
  engine: StateEngine,
  herdr: HerdrClient,
  paneId: string,
  url: URL,
  req: Request,
): Promise<Response> {
  const accept = req.headers.get("accept-encoding");
  const unavailable = (reason: "disabled" | "no-session" | "no-log") =>
    json({ paneId, available: false, reason } satisfies PaneHistoryResponse, accept);

  if (!cfg.transcript || transcripts === null || journals === null) return unavailable("disabled");

  const { agents, shellPanes } = engine.current();
  const pane = [...agents, ...shellPanes].find((a) => a.paneId === paneId);
  // No pane, or an agent that named no session (a shell, or a harness whose integration isn't
  // installed): nothing to read, and that's an ordinary answer rather than an error.
  if (!pane) return unavailable("no-session");
  // An agent with no adapter has no journal. Same answer — the UI shouldn't distinguish "this
  // harness isn't supported" from "this pane never started one"; both mean there's nothing to show.
  const adapter = adapterFor(journals, pane.agent);
  if (adapter === undefined) return unavailable("no-session");
  // WHO DECIDES WHICH LOG THIS PANE IS ON.
  //
  // A harness that reports its own session id (claude, pi) is trusted: the agent itself is telling
  // Herdr what it opened. A cwd-keyed harness is not, because nobody authoritative is speaking for
  // it. Herdr's grok integration DOES report an `agent_session`, but it names the session the pane
  // STARTED with and never follows a new session opened later in that same pane — on 2026-09-08 it
  // was still naming a conversation that had been dead 2.4 hours while the pane was live on
  // another. Trusting it unconditionally is what put the wrong chat on screen.
  //
  // So for a cwd-keyed harness the reported id is handed to the adapter as one input, ranked above
  // a blind guess and below anything the pane itself is showing (journal/grok.ts). It stays the
  // fallback if the adapter can reach no conclusion at all.
  const reportedSessionId =
    pane.agentSession?.kind === "id" ? pane.agentSession.value : undefined;
  const session =
    adapter.inferFromCwd !== undefined && pane.cwd
      ? ((await adapter.inferFromCwd({
          cwd: pane.cwd,
          paneId,
          hint: await paneHistoryHint(herdr, pane),
          peerPaneIds: panePeersAtCwd(agents, shellPanes, pane),
          ...(reportedSessionId !== undefined ? { reportedSessionId } : {}),
        })) ?? pane.agentSession ?? null)
      : (pane.agentSession ?? null);
  if (!session) return unavailable("no-session");

  try {
    const page = await transcripts.page(adapter, session, historyParams(url));
    if (page === null) return unavailable("no-log");
    return json({ paneId, available: true, ...page } satisfies PaneHistoryResponse, accept);
  } catch (err) {
    return text(failureText("transcript read", err), 502);
  }
}

