import type { AgentStatus } from "../../shared/wire.ts";
import type { AgentSessionRef } from "../journal/types.ts";
import type { AgentView } from "../state-engine.ts";
import type { BeaconReading, BeaconStatus } from "./types.ts";

// Beacon → Sightr's own vocabulary. Pure: this is where three words become five, in the decorator
// and never in the file format (types.ts says why).

/**
 * `waiting → blocked` because `STATUS_RANK.blocked = 0` (shared/wire.ts) — the top of triage, which
 * is exactly where an agent that has stopped and is waiting on the operator belongs. Mapping it to
 * `idle` would bury the one pane that needs a human at the bottom of the herd list.
 */
const BEACON_STATUS = {
  working: "working",
  idle: "idle",
  waiting: "blocked",
} satisfies Record<BeaconStatus, AgentStatus>;

/**
 * The shape a harness name has to have to name an adapter.
 *
 * The parse boundary bounded that field at 4096 characters, which is not the same as "a name the
 * journal registry could ever match". A value outside this shape names no adapter, so carrying it
 * would label a pane with something that LOOKS like an identity and resolves to nothing.
 */
const HARNESS_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/u;

/** What a beacon says about one pane, in Sightr's words. `status` is live-only. */
export interface BeaconIdentity {
  readonly agent: string;
  readonly session: AgentSessionRef;
  readonly sessionName?: string;
  readonly status?: AgentStatus;
}

/** One reading as an identity, or null when its harness could never name an adapter. */
export function identityOf(reading: BeaconReading): BeaconIdentity | null {
  const agent = reading.harness.trim().toLowerCase();
  if (!HARNESS_NAME.test(agent)) return null;
  return {
    agent,
    session: reading.session,
    ...(reading.sessionName === undefined ? {} : { sessionName: reading.sessionName }),
    ...(reading.liveness === "live" ? { status: BEACON_STATUS[reading.status] } : {}),
  };
}

/** The identities, keyed by pane. Readings whose harness is unusable are dropped. */
export function beaconsByPane(readings: readonly BeaconReading[]): Map<string, BeaconIdentity> {
  const byPane = new Map<string, BeaconIdentity>();
  for (const reading of readings) {
    const identity = identityOf(reading);
    if (identity !== null) byPane.set(reading.paneId, identity);
  }
  return byPane;
}

/** The pane's beacon when it describes the harness now in the pane; undefined otherwise. */
export function matchingBeacon(
  view: AgentView,
  identity: BeaconIdentity | undefined,
): BeaconIdentity | undefined {
  return identity !== undefined && identity.agent === view.agent ? identity : undefined;
}

/** Whether a (matching) beacon's session and name apply: Herdr named none, or named the same one. */
export function beaconSessionApplies(view: AgentView, identity: BeaconIdentity): boolean {
  const herdr = view.agentSession;
  return (
    herdr === undefined ||
    (herdr.kind === identity.session.kind && herdr.value === identity.session.value)
  );
}

/**
 * A view with what the beacon knows written onto it, or the SAME view when there is no beacon.
 *
 * Fields are assigned rather than conditionally spread over the whole object, so a field the beacon
 * does not supply stays absent rather than becoming `undefined`.
 *
 * A beacon does NOT promote a shell pane to an agent pane, and `decorateAgent` never changes
 * `agent`, `kind` or `paneId`. That is a decision, not an omission: Herdr already reports the
 * harness in the pane it owns, and promoting a shell on the strength of a file in a directory is a
 * far bigger behaviour change than reading an identity the agent volunteered.
 *
 * The session is the part a stale file can get wrong (spec 07). After `/clear`, `/resume` or a
 * harness swap, the hook file still names yesterday's chat, so:
 *  - a beacon for another harness describes whatever ran here before, and none of it applies;
 *  - Herdr's own session id wins over the beacon's when the two differ;
 *  - otherwise (Herdr named none) the beacon's session opens history, live or expired, because
 *    history is history. Status stays live-only (`identityOf`).
 */
export function decorateAgent(view: AgentView, identity: BeaconIdentity | undefined): AgentView {
  const beacon = matchingBeacon(view, identity);
  if (beacon === undefined) return view;
  const sessionApplies = beaconSessionApplies(view, beacon);
  if (!sessionApplies && beacon.status === undefined) return view;
  const decorated: AgentView = { ...view };
  if (sessionApplies) {
    decorated.agentSession = beacon.session;
    if (beacon.sessionName !== undefined) decorated.sessionName = beacon.sessionName;
  }
  if (beacon.status !== undefined) decorated.status = beacon.status;
  return decorated;
}
