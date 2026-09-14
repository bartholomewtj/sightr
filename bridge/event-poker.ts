import type { HerdrClient } from "./herdr-client.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Event-poked polling. A long-lived events.subscribe stream whose ONLY job is to
// trigger immediate (debounced) re-polls. While the stream is healthy the engine
// relaxes to a safety-net cadence; when it's down the engine falls back to fast
// polling. Backoff resets only after STABLE_MS of healthy stream, so an ack-then-drop
// server escalates instead of looping at 1 s. Events are never state here — a missed
// event costs one interval, never correctness — so the snapshot poll stays the single
// source of truth. See index.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** A subscription request entry: global (just `type`) or pane-scoped (needs `pane_id`). */
export type Subscription = { type: string; pane_id?: string };

// Global events that change what Sightr's snapshot renders. We deliberately DROP layout.*,
// worktree.*, pane.scroll_changed and pane.output_matched — none of them alter the herd view we
// poll for, so subscribing would only add pokes that re-fetch identical state. Also NO
// workspace.moved / tab.moved: they're new in herdr 0.7.2, and one unknown subscription type
// rejects the whole subscribe — which would keep the stream permanently down on exactly the older
// servers the session.snapshot fallback supports. Moves are rare and the safety-net poll covers
// them within one SIGHTR_POLL_IDLE_MS.
const GLOBAL_SUBSCRIPTIONS: readonly string[] = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.closed",
  "workspace.focused",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "pane.created",
  "pane.closed",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
];

/**
 * The full subscription list for the current set of agent panes: every global above, plus one
 * pane-scoped `pane.agent_status_changed` per agent pane (the status flips that drive triage).
 */
export function buildSubscriptions(agentPaneIds: string[]): Subscription[] {
  const subs: Subscription[] = GLOBAL_SUBSCRIPTIONS.map((type) => ({ type }));
  for (const id of agentPaneIds) subs.push({ type: "pane.agent_status_changed", pane_id: id });
  return subs;
}

/** Order-insensitive, duplicate-insensitive comparison — the subscription set only cares which ids. */
export function sameIdSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const id of sa) if (!sb.has(id)) return false;
  return true;
}

/** Timer primitives used by EventPoker; production uses setTimeout, tests can inject a fake clock. */
export interface PokerClock<H> {
  schedule(fn: () => void, delayMs: number): H;
  cancel(handle: H): void;
}

interface EventPokerOpts<H> {
  /** Trailing-debounce window (ms) that coalesces a burst of events into one poke. */
  debounceMs?: number;
  /** Reconnect backoff schedule (ms); the last entry repeats indefinitely. */
  backoffMs?: number[];
  clock?: PokerClock<H>;
}

/** Healthy stream duration required before reconnect backoff resets. */
export const STABLE_MS = 30_000;

export class EventPoker<H = ReturnType<typeof setTimeout>> {
  private readonly debounceMs: number;
  private readonly backoff: number[];
  private readonly clock: PokerClock<H>;
  private agentPanes: string[] = [];
  private started = false;
  private healthy = false;
  private backoffIdx = 0;
  // The active stream handle; identity-compared in callbacks so a superseded stream's late `onDown`
  // (from a deliberate close during reconnect/stop) is ignored instead of flapping health.
  private stream: { close(): void } | null = null;
  private debounceTimer: H | null = null;
  private reconnectTimer: H | null = null;
  private stableTimer: H | null = null;
  private lastLoggedDelay: number | null = null;
  private readonly pokeListeners = new Set<() => void>();
  private readonly healthListeners = new Set<(healthy: boolean) => void>();

  constructor(
    private readonly client: HerdrClient,
    opts: EventPokerOpts<H> = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 200;
    this.backoff = opts.backoffMs ?? [1000, 2000, 5000, 15000];
    this.clock = opts.clock ?? {
      schedule: (fn, delayMs) => setTimeout(fn, delayMs) as H,
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  onPoke(cb: () => void): () => void {
    this.pokeListeners.add(cb);
    return () => this.pokeListeners.delete(cb);
  }

  onHealth(cb: (healthy: boolean) => void): () => void {
    this.healthListeners.add(cb);
    return () => this.healthListeners.delete(cb);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop(): void {
    this.started = false;
    if (this.debounceTimer !== null) {
      this.clock.cancel(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.reconnectTimer !== null) {
      this.clock.cancel(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearStableTimer();
    // Detach BEFORE closing so the close's `onDown` is seen as stale (no health flip, no reconnect).
    const s = this.stream;
    this.stream = null;
    if (s) s.close();
  }

  /** The fresh snapshot after any pane lifecycle event feeds this; a changed set means re-subscribe. */
  setAgentPanes(ids: string[]): void {
    if (sameIdSet(ids, this.agentPanes)) return;
    this.agentPanes = [...ids];
    if (this.started) this.reconnect();
  }

  private connect(): void {
    const subs = buildSubscriptions(this.agentPanes);
    const handle = this.client.subscribeEvents({
      subscriptions: subs,
      onUp: () => {
        if (this.stream !== handle) return;
        if (this.backoffIdx > 0 && this.stableTimer === null) {
          this.stableTimer = this.clock.schedule(() => {
            this.stableTimer = null;
            this.backoffIdx = 0;
            this.lastLoggedDelay = null;
          }, STABLE_MS);
        }
        // A resubscribe acks while already healthy, so setHealthy dedupes it silently — but it's
        // the only journal evidence that the per-pane subscriptions followed the herd. Log it.
        if (this.healthy) console.log(`[events] resubscribed (${subs.length} subscriptions)`);
        this.setHealthy(true, subs.length);
      },
      onEvent: () => {
        if (this.stream !== handle) return;
        this.schedulePoke();
      },
      onDown: (reason) => {
        if (this.stream !== handle) return;
        this.stream = null;
        this.clearStableTimer();
        this.setHealthy(false, subs.length, reason);
        if (this.started) this.scheduleReconnect();
      },
    });
    this.stream = handle;
  }

  private reconnect(): void {
    if (this.reconnectTimer !== null) {
      this.clock.cancel(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const old = this.stream;
    this.stream = null;
    if (old) old.close();
    this.connect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.backoff[Math.min(this.backoffIdx, this.backoff.length - 1)] ?? 1000;
    this.backoffIdx++;
    if (this.lastLoggedDelay !== delay) {
      console.log(`[events] reconnecting in ${delay}ms`);
      this.lastLoggedDelay = delay;
    }
    this.reconnectTimer = this.clock.schedule(() => {
      this.reconnectTimer = null;
      if (this.started) this.connect();
    }, delay);
  }

  private schedulePoke(): void {
    if (this.debounceTimer !== null) this.clock.cancel(this.debounceTimer);
    this.debounceTimer = this.clock.schedule(() => {
      this.debounceTimer = null;
      for (const cb of this.pokeListeners) cb();
    }, this.debounceMs);
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) {
      this.clock.cancel(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private setHealthy(healthy: boolean, subCount: number, reason?: string): void {
    if (this.healthy === healthy) return;
    this.healthy = healthy;
    if (healthy) console.log(`[events] stream up (${subCount} subscriptions)`);
    else console.log(`[events] stream down: ${reason ?? "unknown"} — fast polling until it recovers`);
    for (const cb of this.healthListeners) cb(healthy);
  }
}
