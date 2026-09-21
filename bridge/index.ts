import { migrateLegacyState } from "./state-migrate";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ACTIVITY_KEY, ActivityLedger } from "./activity.ts";
import { createAuditLog } from "./audit.ts";
import { loadConfig, type Config } from "./config.ts";
import { EventPoker } from "./event-poker.ts";
import { DEFAULT_TIMEOUT_MS, HerdrClient } from "./herdr-client.ts";
import { HERD_TAG, NotificationCoordinator, makeNotifySink, type NotifyClock } from "./notifications.ts";
import { NotifyPrefsStore } from "./notify-prefs.ts";
import { RuntimeSettingsStore } from "./runtime-settings.ts";
import { Push } from "./push.ts";
import { createLockStore } from "./lock.ts";
import { startServer } from "./server.ts";
import { engineCadence, StateEngine } from "./state-engine.ts";
import { beaconReader } from "./beacon-io.ts";
import { SWEEP_INTERVAL_MS, sweepUploads } from "./uploads.ts";

// Entry point: resolve config, wire the pieces, start polling and serving.
// loadConfig throws on a config that would be unsafe to serve (a non-loopback bind). Print the
// reason alone — a stack trace here buries the one line the operator needs.
let cfg: Config;
try {
  cfg = loadConfig();
} catch (err) {
  console.error(`[bridge] FATAL: ${(err as Error).message}`);
  process.exit(1);
}

// Ensure the state dir exists with private (0700) perms before push/uploads write into it —
// it holds push subscription endpoints and uploaded images, so keep it owner-only.
const migratedFrom = await migrateLegacyState(cfg.stateDir);
if (migratedFrom) console.log(`state: copied pre-1.0 Sighter state from ${migratedFrom}`);
await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 });

const audit = createAuditLog({ stateDir: cfg.stateDir, enabled: cfg.audit, content: cfg.auditContent });

// ── Process-global services ───────────────────────────────────────────────────
const push = new Push(cfg);
await push.init();

const lock = createLockStore(cfg.stateDir);

const notifyPrefs = new NotifyPrefsStore(cfg);
await notifyPrefs.load();

const settings = new RuntimeSettingsStore(cfg);
await settings.load();

// When each pane last moved, and when you last looked at it — the two numbers the dashboard sorts
// and triages by (see activity.ts).
const activity = new ActivityLedger(cfg);
await activity.load();

// ── Herdr runtime ────────────────────────────────────────────────────────────
// One HerdrClient + StateEngine + EventPoker + NotificationCoordinator for the one Herdr at
// cfg.socketPath.
let snapshotEvents: import("./events-route.ts").SnapshotEvents | undefined;
const herdr = new HerdrClient(cfg.socketPath, DEFAULT_TIMEOUT_MS);
// The beacon directory is created by the emitter (Claude's hook), not here: the bridge only reads
// it, and a directory that does not exist yet is the ordinary first-run case.
const engine = new StateEngine(herdr, cfg.pollMs, Date.now, cfg.beacons ? beaconReader(cfg.stateDir) : null);

// Event-poked polling: a long-lived events.subscribe stream pokes an immediate re-poll on any herd
// change. While the stream is healthy AND every agent is resting, the interval relaxes to the
// safety-net cadence; working or blocked panes stay on the fast poll because output does not emit a
// poke. Events are ONLY a poke — the snapshot poll stays the source of truth — so a missed event
// costs one interval, not correctness. The fresh snapshot after any pane lifecycle change
// re-scopes the subscriptions.
const poker = new EventPoker(herdr);
let eventsHealthy = false;
const applyCadence = () => {
  engine.setCadence(engineCadence(eventsHealthy, engine.current().agents, cfg.pollMs, cfg.pollIdleMs));
};
poker.onPoke(() => engine.pokeNow());
poker.onHealth((h) => {
  eventsHealthy = h;
  applyCadence();
});
engine.onUpdate((s) => poker.setAgentPanes(s.agents.map((a) => a.paneId)));
engine.onUpdate(applyCadence);
engine.onUpdate(() => snapshotEvents?.notify());

// Activity bookkeeping. A status change stamps `activeAt` (the only thing that can make a pane
// read as unseen); every successful poll reconciles the ledger against the panes that exist, which
// seeds first sightings as already-seen and reaps closed ones. Reconciling covers bare shells too,
// which the engine's agent-derived removal event never reports.
engine.onTransition((agent) => activity.noteActive(ACTIVITY_KEY, agent.paneId));
engine.onUpdate((s) =>
  activity.reconcile(ACTIVITY_KEY, [...s.agents, ...s.shellPanes].map((p) => p.paneId)),
);

// Background notifications on lifecycle transitions (foreground toasts are computed client-side by
// diffing snapshots). The whole herd shares one notification slot (HERD_TAG).
const clock: NotifyClock<ReturnType<typeof setTimeout>> = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h),
};
const sink = makeNotifySink(push, HERD_TAG);
const notifications = new NotificationCoordinator(clock, sink, () => settings.current().notifyDelayMs, (status) =>
  notifyPrefs.isNotifiable(status),
);
engine.onTransition((agent, from, to) => notifications.onTransition(agent, from, to));
engine.onRemove((paneId) => notifications.onRemove(paneId));

engine.start();
poker.start();

// Fail soft with a clear message if Herdr isn't reachable at startup.
if (!(await herdr.ping())) {
  console.warn(
    `[bridge] cannot reach Herdr socket at ${cfg.socketPath} yet — ` +
      `will keep retrying on the poll loop. Is the Herdr server running?`,
  );
}

// Prune uploaded images past their TTL: once at startup, then on an interval. Uploads are single-use
// (Herdr reads them by path when the message is sent), so nothing else reclaims them. unref() so the
// timer never keeps the process alive; it's also cleared on shutdown.
const uploadsDir = join(cfg.stateDir, "uploads");
void sweepUploads(uploadsDir).then((removed) => {
  if (removed.length) console.log(`[uploads] swept ${removed.length} expired image(s) at startup`);
});
const sweepTimer = setInterval(() => {
  void sweepUploads(uploadsDir).then((removed) => {
    if (removed.length) console.log(`[uploads] swept ${removed.length} expired image(s)`);
  });
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();

const server = startServer({
  cfg, herdr, engine, notifications, push, notifyPrefs, settings, activity, lock, audit,
  onEvents: (events) => { snapshotEvents = events; },
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log("\n[bridge] shutting down");
  // Stop accepting new connections and let in-flight requests drain briefly (non-forced stop)
  // before we tear down the poll loops and exit.
  await server.stop();
  engine.stop();
  poker.stop();
  // Retract anything still on the lock screen — nothing live stands behind it once we exit.
  notifications.clearAll();
  // Writes are debounced, so the last second or so of "you looked at this" lives only in memory —
  // persist it before exiting, or every restart quietly resurrects alerts you'd already cleared.
  activity.stop();
  await activity.flush();
  clearInterval(sweepTimer);
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) {
  try {
    process.on(signal, shutdown);
  } catch {
    // Some platforms do not support every signal (notably SIGBREAK and SIGHUP).
  }
}
