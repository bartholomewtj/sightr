import { ACTIVITY_KEY, type ActivityLedger } from "./activity.ts";
import type { Config } from "./config.ts";
import { checkAccess, deviceAuth, guard } from "./access.ts";
import { json, text } from "./responses.ts";
import { buildId, withBuildHeader } from "./static-assets.ts";
import { adapterFor } from "./journal/registry.ts";
import type { JournalAdapter } from "./journal/types.ts";
import { TranscriptStore } from "./journal/store.ts";
import type { StateEngine } from "./state-engine.ts";
import type { Push } from "./push.ts";
import type { createSssfViz } from "./sssf-viz.ts";
import type { createWorkdir } from "./workdir.ts";
import type { WorktreeIndex } from "./worktrees.ts";
import type { AgentView } from "./state-engine.ts";
import type { BridgeConfig } from "../shared/wire.ts";
import type * as Wire from "../shared/wire.ts";
export type PaneWire = Wire.WirePane;
export type SnapshotResponse = Omit<Wire.SnapshotResponse, "agents" | "shellPanes"> & { agents: PaneWire[]; shellPanes: PaneWire[] };
export function toPaneWire(pane: AgentView, offerHistory: (agent: string, hasSessionRef: boolean) => boolean): PaneWire { const { agentSession, ...rest } = pane; return offerHistory(pane.agent, Boolean(agentSession)) ? { ...rest, hasSession: true } : rest; }

export interface SnapshotDeps {
  cfg: Config; engine: StateEngine; activity: ActivityLedger;
  sssfViz: ReturnType<typeof createSssfViz>; workdir: ReturnType<typeof createWorkdir>;
  worktrees: WorktreeIndex;
  journals: Record<string, JournalAdapter> | null; transcripts: TranscriptStore | null;
  offerHistory: (agent: string, hasSessionRef: boolean) => boolean;
}

/** True when this snapshot poll should recheck SSSF traces (the phone is on /traces). */
export function snapshotWantsTraces(req: Request): boolean {
  try {
    return new URL(req.url).searchParams.get("traces") === "1";
  } catch {
    return false;
  }
}

/**
 * Paint the running-command chip from the store's last-known answer and kick a background refresh.
 * Synchronous: a miss omits the chip; a stale hit still paints. Never walks the filesystem.
 */
export function stampRunningCommand(
  pane: AgentView,
  journals: Record<string, JournalAdapter> | null,
  transcripts: TranscriptStore | null,
): AgentView {
  if (pane.status !== "working" || !transcripts || !journals) return pane;
  const adapter = adapterFor(journals, pane.agent);
  if (!adapter) return pane;
  const ref = pane.agentSession;
  if (!ref) return pane;
  const running = transcripts.peekRunningCommand(adapter, ref);
  transcripts.scheduleRunningCommandRefresh(adapter, ref);
  return running === true ? { ...pane, runningCommand: true } : pane;
}

export async function snapshotRoute(req: Request, deps: SnapshotDeps): Promise<Response> {
  const gate = checkAccess(req, deps.cfg);
  if (!gate.ok) return text(gate.reason, 403);
  const { agents, shellPanes, workspaces, tabs, bridge } = deps.engine.current();
  const device = deviceAuth(req, deps.cfg);
  // Attach each pane's deps.activity timestamps. Done here rather than in the state engine so the
  // engine stays a pure Herdr-poller with no knowledge of the ledger — and so the two numbers
  // are read at serialise time, i.e. as fresh as the request.
  const withActivity = (p: AgentView): AgentView => {
    const a = deps.activity.get(ACTIVITY_KEY, p.paneId);
    return a ? { ...p, lastActiveAt: a.activeAt, lastSeenAt: a.seenAt } : p;
  };
  // Decorate working agent panes with runningCommand when their journal tail shows a tool
  // call with no result yet. Stamped at serialise time (like withActivity) so the state engine
  // stays a pure Herdr poller. Omitted when deps.cfg.transcript is off (deps.transcripts is null).
  //
  // Never awaits a journal read: the store returns the last known chip (or omits it on first
  // boot) and refreshes in the background. Cwd inference stays on the history route — a working
  // pane without a Herdr-provided session ref simply has no chip.
  const decoratedAgents = agents.map((p) => stampRunningCommand(p, deps.journals, deps.transcripts));
  // Tag every snapshot poll with the bridge's current bundle id so a client can see what it serves.
  return withBuildHeader(
    json({
      bridge,
      // Only report device state when the feature is on, so an off deployment sends nothing new.
      ...(device.enforced ? { device } : {}),
      // The one place a pane leaves the bridge: the session ref is stripped to a presence flag
      // here, so an agent-reported filesystem path never reaches a browser (see toPaneWire).
      // The flag is computed against the journal registry, so a harness Herdr detects but Sightr
      // has no journal for doesn't advertise a History button that can only ever come back empty.
      // withActivity runs FIRST: it returns an AgentView, which is what toPaneWire consumes,
      // and the two timestamps then ride through its rest-spread onto the wire shape.
      // decoratePanes hangs each pane's ADW runs on it (bridge/sssf-viz.ts) — a plain stamp
      // from the last discovery pass, so it costs no I/O here; identity when the feature is off.
      agents: deps.sssfViz.decoratePanes(decoratedAgents).map((p) => toPaneWire(withActivity(p), deps.offerHistory)),
      shellPanes: deps.sssfViz.decoratePanes(shellPanes).map((p) => toPaneWire(withActivity(p), deps.offerHistory)),
      workspaces: await deps.worktrees.decorate(
        deps.sssfViz.decorate(workspaces, [...agents, ...shellPanes], snapshotWantsTraces(req)),
        [...agents, ...shellPanes],
      ),
      tabs,
      ...(deps.workdir.enabled ? { files: true as const } : {}),
      ts: Date.now(),
    } satisfies SnapshotResponse, req.headers.get("accept-encoding")),
    await buildId(),
  );
}

export interface BridgeConfigDeps {
  cfg: Config; push: Push; operatorCommands: ReturnType<typeof import("./operator-commands.ts").createOperatorCommands>; operatorKeys: ReturnType<typeof import("./operator-keys.ts").createOperatorKeys>;
  operatorWheel: ReturnType<typeof import("./operator-keys.ts").createOperatorWheel>;
}
export async function bridgeConfigRoute(req: Request, deps: BridgeConfigDeps): Promise<Response> {
  const denied = guard(req, deps.cfg, "read");
  if (denied) return denied;
  // Re-read per request behind an mtime check, like buildId() — editing commands.toml is live,
  // with no restart. The path is deps.cfg's, never the request's.
  const mine = await deps.operatorCommands();
  const myKeys = await deps.operatorKeys();
  const myWheel = await deps.operatorWheel();
  return json({
    push: deps.push.enabled,
    vapidPublicKey: deps.push.publicKey,
    build: await buildId(),
    // Omitted entirely when there are none, so an operator who never wrote a commands.toml
    // ships the same payload as before.
    ...(mine.length > 0 ? { operatorCommands: mine } : {}),
    ...(myKeys.length > 0 ? { operatorKeys: myKeys } : {}),
    ...(myWheel.length > 0 ? { operatorWheel: myWheel } : {}),
  } satisfies BridgeConfig, req.headers.get("accept-encoding"));
}
