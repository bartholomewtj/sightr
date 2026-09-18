import { meaningfulTabLabel, meaningfulTerminalTitle } from "./activity.ts";
import type { HerdrClient, WireAgent } from "./herdr-client.ts";
import {
  type AgentStatus,
  type BridgeStatus,
  STATUS_RANK,
  type TabView,
  type WorkspaceView,
  type PaneCommon,
} from "../shared/wire.ts";
import type { AgentSessionRef } from "./journal/types.ts";
import { beaconsByPane, decorateAgent, type BeaconIdentity } from "./beacon/decorate.ts";
import { readBeacons, type BeaconSweepDeps } from "./beacon/reader.ts";

export interface AgentView extends PaneCommon { agentSession?: AgentSessionRef; }

/** Trim a Herdr string field; empty/whitespace/non-string become absent. */
function nonempty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Live name and summary from snapshot `agents[]`, keyed by pane. Absent on older servers and on
 * panes Herdr hasn't named. Exported so the join is unit-tested without standing up a poll.
 */
export function overlayFromAgent(info: WireAgent | undefined): { agentName?: string; summary?: string } {
  if (!info) return {};
  const agentName = nonempty(info.name);
  const summary = nonempty(info.tokens?.summary) ?? nonempty(info.title);
  return {
    ...(agentName ? { agentName } : {}),
    ...(summary ? { summary } : {}),
  };
}

// Polls Herdr on an interval, builds the snapshot (agents + shell panes + spaces/tabs), and emits
// transition events. Polling (vs the per-pane event subscription) keeps this resync-free: a failed
// poll just retries next tick, and reconnection needs no special handling. See HERDR_API.md.

// How many lines to read per claude pane when sniffing its `/rename` session name. Claude's input
// box (and the named rule above it) sits at the very tail, so a small window is plenty and keeps the
// extra per-poll reads cheap.
//
// The source MUST stay `visible`. A `recent` text read asking for more rows than the pane currently
// shows makes Herdr harvest the pages above the viewport, and on a full-screen agent (Claude runs on
// the alternate screen, which has no host scrollback) the only way to reach them is to drive the
// agent's own mouse-scroll interface: Herdr scrolls the pane up page by page, then restores it. The
// operator watches their terminal jump and snap back — once per poll, per idle claude pane.
// `visible` cannot do that whatever this count is: it is the rendered viewport, clamped to it. Which
// is also why this number is free to stay generous — the run below the ❯ prompt is a statusline of
// unknown height ([ADR 0004](../.adr/0004-the-statusline-run-is-bounded.md)), so headroom is worth
// more here than a smaller read. See HERDR_API.md → `pane.read`.
const SESSION_NAME_READ_LINES = 40;
/** How stale a cached `/rename` name may get before the next poll re-reads it. */
export const SESSION_NAME_TTL_MS = 60_000;

/**
 * How long a resting status (`idle` / `done` / `unknown`) must persist after `working` before the
 * snapshot believes the turn ended. Several harnesses keep the composer on screen during a turn, so
 * Herdr's detector often reports `done` between tool calls; treating that as a finish paints
 * Ready · unseen (green) then Working on every tool. Blocked is never held — a permission card is
 * not a blip.
 */
export const STATUS_HOLD_MS = 3_000;

const RESTING_STATUS: ReadonlySet<AgentStatus> = new Set(["idle", "done", "unknown"]);

// Claude renders its input box as a horizontal rule, the ❯ prompt line, then a closing rule. After
// `/rename <name>` the TOP rule carries the session name inside it: "────────── my-name ──". This
// matches that named rule. `\S` also matches box-drawing chars, but a *plain* rule has no embedded
// space-delimited text, so it can't match — and the ❯-prompt anchor (below) rules out any decorative
// rule elsewhere in the output. Rule chars: ─ (U+2500, light) and ━ (U+2501, heavy).
const NAMED_RULE = /^[─━]{2,}[ \t]+(\S.*?\S|\S)[ \t]+[─━]+[ \t]*$/;
// Claude's input prompt marker, anchored at column 0. Its menu/selection cursors render as " ❯"
// (leading space), so the column-0 anchor discriminates the real input prompt from a selected row.
const PROMPT_LINE = /^❯/;

/**
 * Pull Claude's own session name (set via `/rename`) out of a pane's visible text, or `undefined` when
 * the session is unnamed (a plain rule) or the pane isn't showing its input box (a dialog, a working
 * spinner). Claude draws the name INTO the horizontal rule directly above the ❯ prompt, e.g.
 * `────────── my-name ──`; we accept that rule ONLY when the very next line is the ❯ prompt, so a
 * decorative rule anywhere else in the output can never be mistaken for it (no false positives).
 * Derived from Claude's UI grammar — claude-only; other harnesses never call this. Pure + exported so
 * it's unit-tested against the pane fixtures without standing up the socket client.
 */
export function extractClaudeSessionName(text: string): string | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  // Only the BOTTOMMOST ❯ counts — that's the live input prompt; anything above it is scrollback.
  // The rule directly above it decides, and a plain rule means "unnamed", full stop. Scanning past it
  // for older named-rule-above-❯ pairs (as this once did) let a scrollback line that merely starts
  // with ❯ — an echoed shell prompt, pasted text — sit under a decorative rule and pin a bogus name
  // on an unnamed session (the caller's sticky cache only overwrites on truthy matches).
  for (let i = lines.length - 1; i >= 1; i--) {
    if (!PROMPT_LINE.test(lines[i]!)) continue;
    const m = NAMED_RULE.exec(lines[i - 1]!);
    return m ? m[1]!.trim() || undefined : undefined;
  }
  return undefined;
}

export interface EngineSnapshot {
  agents: AgentView[];
  shellPanes: AgentView[];
  workspaces: WorkspaceView[];
  tabs: TabView[];
  bridge: BridgeStatus;
}

type TransitionListener = (agent: AgentView, from: AgentStatus, to: AgentStatus) => void;
type RemoveListener = (paneId: string) => void;
type UpdateListener = (snap: EngineSnapshot) => void;

export class StateEngine {
  private agents: AgentView[] = [];
  private shellPanes: AgentView[] = [];
  private workspaces: WorkspaceView[] = [];
  private tabs: TabView[] = [];
  private bridge: BridgeStatus = "disconnected";
  private readonly prevStatus = new Map<string, AgentStatus>();
  // Last-known claude `/rename` session name per pane. Kept sticky so the name doesn't flicker away
  // when a pane momentarily hides its input box (a dialog / working spinner) — only cleared when the
  // pane itself vanishes (see the removal loop). Enriched from pane text each poll (see enrichSessionNames).
  private readonly sessionNames = new Map<string, string>();
  /** When each claude pane's name was last read, and the status it had then. */
  private readonly nameReads = new Map<string, { at: number; status: AgentStatus }>();
  /**
   * The pane revision each claude pane was last read at. Herdr stamps every pane with a content
   * revision that moves only when the pane's rendered text changed, so a pane whose revision has
   * not moved cannot have a new `/rename` name on it — and re-reading it is one socket round trip
   * spent to learn nothing. The TTL below is what re-read an idle herd every 60s; this makes the
   * cost O(panes that changed) instead. A server that omits `revision` simply falls through to the
   * TTL rule, unchanged.
   */
  private readonly nameReadRevisions = new Map<string, number>();
  /** Pane id → when a working→resting hold began. Cleared on working/blocked, a real rest, or removal. */
  private readonly statusHold = new Map<string, number>();
  private readonly transitionListeners = new Set<TransitionListener>();
  private readonly removeListeners = new Set<RemoveListener>();
  private readonly updateListeners = new Set<UpdateListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private polling = false;
  // One follow-up poll queued when pokeNow lands mid-poll: an event may describe state the
  // in-flight poll already read past, so we must re-poll once it settles.
  private queuedPoll = false;
  // Current interval cadence; setCadence swaps it (relaxed while the event stream is healthy).
  private cadenceMs: number;
  // session.snapshot is the fast path; flipped off PERMANENTLY once a server proves it predates the
  // method (see poll()), after which every tick uses the legacy three-call path.
  private supportsSnapshot = true;

  constructor(
    private readonly herdr: HerdrClient,
    private readonly pollMs: number,
    private readonly now: () => number = Date.now,
    /**
     * Where the identity files Claude's own hooks write are read from, or null when the operator
     * turned beacons off. Defaulted, so every existing call site and test is unchanged and a bridge
     * with no beacons behaves exactly as it did before they existed.
     */
    private readonly beacons: BeaconSweepDeps | null = null,
  ) {
    this.cadenceMs = pollMs;
  }

  onTransition(fn: TransitionListener): () => void {
    this.transitionListeners.add(fn);
    return () => this.transitionListeners.delete(fn);
  }

  /** Fires when a previously-seen agent pane vanishes (closed/exited) — used to retract its push. */
  onRemove(fn: RemoveListener): () => void {
    this.removeListeners.add(fn);
    return () => this.removeListeners.delete(fn);
  }

  /** Fires after every successful poll (post-transition bookkeeping) with the fresh snapshot; SSE fans out from this subscription. */
  onUpdate(fn: UpdateListener): () => void {
    this.updateListeners.add(fn);
    return () => this.updateListeners.delete(fn);
  }

  current(): EngineSnapshot {
    return {
      agents: this.agents,
      shellPanes: this.shellPanes,
      workspaces: this.workspaces,
      tabs: this.tabs,
      bridge: this.bridge,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.cadenceMs = this.pollMs;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.cadenceMs);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Keep publishing `working` until a resting status has lasted {@link STATUS_HOLD_MS}. Incoming
   * `working` / `blocked` (and a first sighting) pass through. Pure against `prevStatus` + the hold
   * map; the published status is what transitions and unseen then see.
   */
  private applyStatusHold(agents: AgentView[]): AgentView[] {
    const now = this.now();
    const live = new Set(agents.map((a) => a.paneId));
    for (const id of this.statusHold.keys()) {
      if (!live.has(id)) this.statusHold.delete(id);
    }
    return agents.map((a) => {
      const prev = this.prevStatus.get(a.paneId);
      if (prev === "working" && RESTING_STATUS.has(a.status)) {
        const since = this.statusHold.get(a.paneId);
        if (since === undefined) {
          this.statusHold.set(a.paneId, now);
          return { ...a, status: "working" };
        }
        if (now - since < STATUS_HOLD_MS) return { ...a, status: "working" };
        this.statusHold.delete(a.paneId);
        return a;
      }
      this.statusHold.delete(a.paneId);
      return a;
    });
  }

  /**
   * Poll right now (event-poked). If a poll is already in flight, queue exactly one follow-up to run
   * when it finishes — the event that poked us may describe state that poll already read past.
   * No-op once stopped.
   */
  pokeNow(): void {
    if (!this.started) return;
    if (this.polling) {
      this.queuedPoll = true;
      return;
    }
    void this.poll();
  }

  /** Re-arm the interval at a new cadence (relaxed while events are healthy). No-op if unchanged or stopped. */
  setCadence(ms: number): void {
    if (!this.started || ms === this.cadenceMs) return;
    this.cadenceMs = ms;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.poll(), ms);
  }

  /**
   * Fetch the herd, preferring the single `session.snapshot` round-trip. Only an "unknown variant"
   * error (the server predates the method) trips a PERMANENT fallback — and we fall through to the
   * legacy three list calls in the SAME tick so there's no missed poll. Any other failure (timeout,
   * closed socket) is transient: it propagates so the tick fails as before, snapshot mode intact.
   */
  private async fetchWire() {
    if (this.supportsSnapshot) {
      try {
        const snap = await this.herdr.sessionSnapshot();
        return { workspaces: snap.workspaces, panes: snap.panes, tabs: snap.tabs, agents: snap.agents ?? [] };
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("unknown variant"))) throw err;
        this.supportsSnapshot = false;
        console.log("[state] herdr predates session.snapshot — using list-call polling");
      }
    }
    const [workspaces, panes, tabs] = await Promise.all([
      this.herdr.listWorkspaces(),
      this.herdr.listPanes(),
      this.herdr.listTabs(),
    ]);
    return { workspaces, panes, tabs, agents: [] as WireAgent[] };
  }

  private async poll(): Promise<void> {
    // Skip the tick if the previous poll is still running — against a slow Herdr, back-to-back
    // ticks would otherwise stack overlapping in-flight polls.
    if (this.polling) return;
    this.polling = true;
    try {
      const { workspaces, panes, tabs, agents: agentRecords } = await this.fetchWire();
      const wsById = new Map(workspaces.map((w) => [w.workspace_id, w]));
      const tabById = new Map(tabs.map((t) => [t.tab_id, t]));
      const agentByPane = new Map(agentRecords.map((a) => [a.pane_id, a]));

      const toView = (
        p: (typeof panes)[number],
        agent: string,
        kind: "agent" | "shell",
      ): AgentView => {
        const ws = wsById.get(p.workspace_id);
        // The tab's label, denormalised alongside workspaceLabel so no client has to join tabs[].
        // Dropped when it's Herdr's positional default in a single-tab space — see meaningfulTabLabel.
        const tabLabel = meaningfulTabLabel(tabById.get(p.tab_id)?.label, ws?.tab_count ?? 0);
        const workspaceLabel = ws?.label ?? p.workspace_id;
        // What the pane says it is doing. Dropped when it only repeats the agent name or the
        // project already on line one — see meaningfulTerminalTitle.
        const terminalTitle = meaningfulTerminalTitle(
          p.terminal_title,
          p.terminal_title_stripped,
          agent,
          workspaceLabel,
        );
        return {
          paneId: p.pane_id,
          workspaceId: p.workspace_id,
          workspaceLabel,
          workspaceNumber: ws?.number ?? 0,
          tabId: p.tab_id,
          agent,
          status: p.agent_status,
          cwd: p.cwd,
          focused: p.focused,
          kind,
          // A user-set pane label (herdr pane.rename); omitted when unset so "absent stays absent".
          ...(typeof p.label === "string" && p.label.length > 0 ? { paneLabel: p.label } : {}),
          ...overlayFromAgent(agentByPane.get(p.pane_id)),
          ...(tabLabel ? { tabLabel } : {}),
          ...(terminalTitle ? { terminalTitle } : {}),
          // How the agent named its session. BOTH kinds are kept: Claude reports an `id`,
          // while pi reports a `path` (its herdr integration prefers `agent_session_path` whenever
          // the session manager has a file open). Keeping only `id` — as this did until journals
          // became per-agent — silently denied pi any history at all. Which kinds are meaningful is
          // now the adapter's call, not this function's; anything else is omitted, so "no history
          // for this pane" stays simply the field being absent.
          //
          // The ref must also BELONG to the agent currently in the pane. Herdr keeps reporting the
          // last session announced for a pane, so relaunching a pane's agent as a different harness
          // leaves the old one's ref behind — live-observed: a pane running `pi` still advertising
          // `{source:"herdr:claude", kind:"id"}` from the claude that had been there before. Serving
          // that would hand pi's adapter a Claude uuid; harmless today (it resolves to nothing) but
          // only by luck. `agent_session.agent` is compared when Herdr reports it, and absence stays
          // permissive so an older server that omits the field still works.
          ...((p.agent_session?.kind === "id" || p.agent_session?.kind === "path") &&
          typeof p.agent_session.value === "string" &&
          p.agent_session.value !== "" &&
          (typeof p.agent_session.agent !== "string" ||
            p.agent_session.agent === "" ||
            p.agent_session.agent === agent)
            ? { agentSession: { kind: p.agent_session.kind, value: p.agent_session.value } }
            : {}),
          // Scrollback depth + viewport = what a `recent` read can yield. Omitted when the server
          // predates `scroll`, so an older Herdr simply reads as "unknown" rather than "zero".
          ...(p.scroll
            ? { readableLines: p.scroll.max_offset_from_bottom + p.scroll.viewport_rows }
            : {}),
        };
      };

      // Narrowing predicate so the agent name is `string` (not `string | null | undefined`) at the
      // map site below — no cast needed.
      const hasAgent = (p: (typeof panes)[number]): p is (typeof panes)[number] & { agent: string } =>
        typeof p.agent === "string" && p.agent.length > 0;

      // Triage order: what needs you first, then by space, then by pane so the list is stable.
      const byTriage = (a: AgentView, b: AgentView) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        a.workspaceNumber - b.workspaceNumber ||
        a.paneId.localeCompare(b.paneId);

      const polled: AgentView[] = panes.filter(hasAgent).map((p) => toView(p, p.agent, "agent"));

      // BEACONS. An agent that named itself beats anything read off its screen (bridge/beacon/).
      // The sweep is best-effort in the strongest sense: a beacon directory must never be able to
      // fail a poll, so a rejection here reads as "no beacons" and the herd view is built exactly as
      // it always was. Shell panes are not decorated — a file in a directory does not promote a
      // shell to an agent (see beacon/decorate.ts).
      const identities: Map<string, BeaconIdentity> = this.beacons
        ? beaconsByPane(await readBeacons(this.beacons).catch(() => []))
        : new Map();
      // Sorted AFTER decoration, because a beacon can change a pane's status and the herd list is
      // ordered by it — a pane that says it is waiting on you belongs at the top of the list, not
      // wherever the poll's own reading had put it. The hold runs before the sort so a pane we are
      // still calling `working` does not jump into Ready · unseen for a beat.
      const agents: AgentView[] = this.applyStatusHold(
        polled.map((a) => decorateAgent(a, identities.get(a.paneId))),
      ).sort(byTriage);

      // Bare shell panes (no agent), ordered by space then pane so a space's panes read top-down.
      const shellPanes: AgentView[] = panes
        .filter((p) => !p.agent)
        .map((p) => toView(p, "shell", "shell"))
        .sort((a, b) => a.workspaceNumber - b.workspaceNumber || a.paneId.localeCompare(b.paneId));

      const workspaceViews: WorkspaceView[] = workspaces
        .map((w) => ({
          workspaceId: w.workspace_id,
          number: w.number,
          label: w.label,
          focused: w.focused,
          activeTabId: w.active_tab_id,
          tabCount: w.tab_count,
          paneCount: w.pane_count,
          ...(w.worktree
            ? {
                worktree: {
                  repoKey: w.worktree.repo_key,
                  repoName: w.worktree.repo_name,
                  repoRoot: w.worktree.repo_root,
                  checkoutPath: w.worktree.checkout_path,
                  isLinkedWorktree: w.worktree.is_linked_worktree,
                },
              }
            : {}),
        }))
        .sort((a, b) => a.number - b.number);

      const tabViews: TabView[] = tabs.map((t) => ({
        tabId: t.tab_id,
        workspaceId: t.workspace_id,
        number: t.number,
        label: t.label,
        focused: t.focused,
        paneCount: t.pane_count,
      }));

      // Detect transitions against the previous poll. First sighting of a pane never fires a
      // transition (so we don't notify for agents already blocked when the bridge starts).
      for (const a of agents) {
        const prev = this.prevStatus.get(a.paneId);
        if (prev !== undefined && prev !== a.status) {
          for (const fn of this.transitionListeners) fn(a, prev, a.status);
        }
        this.prevStatus.set(a.paneId, a.status);
      }
      const live = new Set(agents.map((a) => a.paneId));
      for (const id of [...this.prevStatus.keys()]) {
        if (live.has(id)) continue;
        this.prevStatus.delete(id);
        this.sessionNames.delete(id); // drop the cached name so a reused pane id starts clean
        this.nameReads.delete(id);
        this.nameReadRevisions.delete(id);
        this.statusHold.delete(id);
        for (const fn of this.removeListeners) fn(id);
      }

      // Enrich claude panes with their own `/rename` session name (read from pane text). Best-effort:
      // a failed read keeps the last-known name and never fails the poll.
      const revisions = new Map<string, number>();
      for (const p of panes) {
        if (typeof p.revision === "number") revisions.set(p.pane_id, p.revision);
      }
      // A pane whose beacon supplied a name is not grid-read for one — the agent already said it.
      const named = new Set(
        [...identities].filter(([, i]) => i.sessionName !== undefined).map(([paneId]) => paneId),
      );
      await this.enrichSessionNames(agents, revisions, named);

      this.agents = agents;
      this.shellPanes = shellPanes;
      this.workspaces = workspaceViews;
      this.tabs = tabViews;
      this.bridge = "connected";

      // After all transition/removal bookkeeping so listeners see a consistent, current snapshot.
      const snap = this.current();
      for (const fn of this.updateListeners) fn(snap);
    } catch (err) {
      if (this.bridge === "connected") {
        console.warn(`[state] poll failed, marking disconnected: ${(err as Error).message}`);
      }
      this.bridge = "disconnected";
    } finally {
      this.polling = false;
      // Run the single follow-up an event-poke asked for while this poll was in flight.
      if (this.queuedPoll) {
        this.queuedPoll = false;
        if (this.started) void this.poll();
      }
    }
  }

  /**
   * Read each claude pane's visible text and attach its `/rename` session name (see
   * {@link extractClaudeSessionName}) to the view, exactly parallel to `paneLabel`. The name lives
   * only in the pane's rendered text — Herdr's pane metadata doesn't carry it — so this is the one
   * place all panes can pick it up (the web app only holds text for the open pane). Reads run in
   * parallel and are individually best-effort: a read that fails or times out keeps the last-known
   * name (sticky cache) and never fails the poll. Claude-only; other harnesses never set it. A
   * herdr client without `readPane` (the unit-test fake) short-circuits, so it's a no-op there.
   */
  private async enrichSessionNames(
    agents: AgentView[],
    revisions: Map<string, number>,
    /** Panes whose beacon already supplied a session name — never read off the screen. */
    named: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    if (typeof this.herdr.readPane !== "function") return;
    const claude = agents.filter((a) => a.agent === "claude" && !named.has(a.paneId));
    if (claude.length === 0) return;
    await Promise.all(
      claude.filter((a) => {
        const entry = this.nameReads.get(a.paneId);
        if (!entry) return true;
        // A pane whose text has not changed since the last read has nothing new to say, so the TTL
        // has nothing to find and the read is a socket round trip spent to learn nothing. This is
        // what makes an idle herd cost no reads at all. A status change still re-reads: status is
        // Herdr's own reading of the pane, not ours, and it may move for a reason the rendered text
        // does not carry. A pane Herdr reports no revision for falls through to the TTL, unchanged.
        const rev = revisions.get(a.paneId);
        if (rev !== undefined && this.nameReadRevisions.get(a.paneId) === rev && entry.status === a.status) {
          return false;
        }
        return entry.status !== a.status || this.now() - entry.at >= SESSION_NAME_TTL_MS;
      }).map(async (a) => {
        try {
          // `visible` — never `recent`; see SESSION_NAME_READ_LINES for what a `recent` read does
          // to the operator's screen. The visible grid is also strictly safer to parse: `recent`
          // hands back transcript scrollback, where Claude echoes past user messages as `❯ …` lines
          // that the prompt anchor below would have to discriminate against.
          const read = await this.herdr.readPane(a.paneId, "visible", SESSION_NAME_READ_LINES, "text");
          const name = extractClaudeSessionName(read.text);
          if (name) this.sessionNames.set(a.paneId, name);
        } catch {
          // Keep whatever's cached (if anything) — a transient read failure must not blank the name.
        } finally {
          // A failed read still consumes this pane's budget; its cached name remains sticky and may
          // be refreshed after the TTL, avoiding an RPC storm while Herdr is unhealthy. The
          // revision is stamped here too — a read that failed on this text will fail again on the
          // same text, so retrying it before the pane moves buys nothing.
          this.nameReads.set(a.paneId, { at: this.now(), status: a.status });
          const rev = revisions.get(a.paneId);
          if (rev !== undefined) this.nameReadRevisions.set(a.paneId, rev);
        }
      }),
    );
    for (const a of agents) {
      // `named` panes are skipped: the beacon's name is the agent's own word for itself, and the
      // sticky cache holds whatever was last scraped off the screen — which may be older.
      if (named.has(a.paneId)) continue;
      const name = this.sessionNames.get(a.paneId);
      if (name) a.sessionName = name;
    }
  }
}
