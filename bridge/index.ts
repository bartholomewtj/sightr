import { migrateLegacyState } from "./state-migrate";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ACTIVITY_KEY, ActivityLedger } from "./activity.ts";
import { createAuditLog } from "./audit.ts";
import { createConnLog } from "./conn-log.ts";
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
import { buildId } from "./static-assets.ts";
import { SWEEP_INTERVAL_MS, sweepUploads } from "./uploads.ts";
import { openThreadStore, STORE_FILE, StoreTooNewError, type ThreadStore } from "./threads/store.ts";
import { createHerdIngestor } from "./threads/herd-ingest.ts";
import { buildJournalRegistry } from "./journal/registry.ts";
import { TranscriptStore } from "./journal/store.ts";
import { createJournalIngestor, createThreadWatchers } from "./threads/journal-ingest.ts";
import { createRequestIngestor } from "./threads/request-ingest.ts";
import { createPaneQueue } from "./pane-queue.ts";
import { createV2Gate } from "./threads/herdr-floor.ts";
import { respondEffect } from "./threads/v2-routes.ts";
import { createGuardedSender } from "./guarded-send-route.ts";
import { createDispatcher } from "./threads/dispatch.ts";
import { createSpawner } from "./threads/spawn.ts";
import { createLiveModes } from "./threads/live-modes.ts";

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

// ── v2 thread store ─────────────────────────────────────────────────────────────────────────────
// One SQLite file in the state dir holds the v2 events and their projection. SIGHTR_V2=0 skips it.
// A database a newer bridge wrote (or any other open failure) leaves v2 off; v1 is unaffected.
// T02 and T05 take the store from here.
let threadStore: ThreadStore | null = null;
let v2DisabledReason = "v2 is off on this bridge (SIGHTR_V2=0)";
if (process.env.SIGHTR_V2?.trim() !== "0") {
  try {
    threadStore = openThreadStore(join(cfg.stateDir, STORE_FILE));
    threadStore.prune(Date.now());
  } catch (err) {
    const why = err instanceof StoreTooNewError ? err.message : `could not open it: ${(err as Error).message}`;
    console.warn(`[threads] v2 is off: ${why}`);
    v2DisabledReason = `v2 is off on this bridge: ${err instanceof StoreTooNewError ? err.message : "the thread store could not be opened"}`;
    threadStore = null;
  }
}
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const pruneTimer = setInterval(() => {
  try {
    threadStore?.prune(Date.now());
  } catch (err) {
    console.warn(`[threads] prune failed: ${(err as Error).message}`);
  }
}, PRUNE_INTERVAL_MS);
pruneTimer.unref();

const audit = createAuditLog({ stateDir: cfg.stateDir, enabled: cfg.audit, content: cfg.auditContent });
// Connection telemetry (`sightr-ctl conn` reads it back). A start line marks every restart, so the
// report can tell an outage the bridge caused from one the network did.
const conn = createConnLog({ stateDir: cfg.stateDir, enabled: cfg.connLog });
conn.bridge({ kind: "bridge.start", version: await buildId() });

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
let herdrDownAt: number | null = null;
engine.onLink((status, err) => {
  if (status === "disconnected") {
    herdrDownAt = Date.now();
    conn.bridge({ kind: "herdr.down", err: (err ?? "").replace(/\s+/g, " ").slice(0, 120) });
  } else {
    conn.bridge({ kind: "herdr.up", downMs: herdrDownAt === null ? null : Date.now() - herdrDownAt });
    herdrDownAt = null;
  }
});

// Activity bookkeeping. A status change stamps `activeAt` (the only thing that can make a pane
// read as unseen); every successful poll reconciles the ledger against the panes that exist, which
// seeds first sightings as already-seen and reaps closed ones. Reconciling covers bare shells too,
// which the engine's agent-derived removal event never reports.
engine.onTransition((agent) => activity.noteActive(ACTIVITY_KEY, agent.paneId));
engine.onUpdate((s) =>
  activity.reconcile(ACTIVITY_KEY, [...s.agents, ...s.shellPanes].map((p) => p.paneId)),
);

// One journal registry for the process: the routes read transcripts from it, and the v2 herd ingest
// asks it which harnesses have a journal.
const journals = cfg.transcript ? buildJournalRegistry(cfg.journalRoots, cfg.stateDir) : null;

// v2 herd ingest: workspaces → projects, panes → threads. Subscribed after the activity bookkeeping
// above, so the ledger already holds this poll's transitions and first sightings when it reads them.
const herdIngestor = threadStore ? createHerdIngestor({ store: threadStore, engine, activity, journals }) : null;

// v2 journal ingest: harness logs → turn items, herdr status → runs. It reads a thread's log only
// while the thread is working or a client watches it (T05 adds and removes watchers).
const transcripts = cfg.transcript ? new TranscriptStore() : null;
const threadWatchers = createThreadWatchers();
const journalIngestor = threadStore
  ? createJournalIngestor({ store: threadStore, engine, herdr, journals, transcripts, watchers: threadWatchers })
  : null;

// One pane write queue for the process: the routes' writes, the v2 request reads and the v2 respond
// all take turns on it, so a read never lands between a reply's steps.
const paneWrites = createPaneQueue();

// v2 request ingest: a waiting pane's dialog becomes a runtime request, answered by its bound keys.
// Subscribed after the herd ingest, so it reads each poll's statuses. T05 routes
// `runtime-request.respond` to `requestIngestor.respond`.
const requestIngestor = threadStore
  ? createRequestIngestor({ store: threadStore, engine, herdr, queue: paneWrites, cfg, audit })
  : null;

// v2 dispatch (T06): message.dispatch start/queue/steer, the server-held queue and run.interrupt. The
// start path is the same guarded send as v1's /api/pane/:id/send, on the same pane write queue. The
// drainer holds every queued row at start; nothing is sent after a restart until the operator resumes.
const guardedSender = createGuardedSender(herdr, cfg, engine, paneWrites);
const dispatcher = threadStore
  ? createDispatcher({
      store: threadStore,
      sender: guardedSender,
      herdr,
      engine,
      queue: paneWrites,
      journal: journalIngestor,
      audit,
    })
  : null;

// v2 spawn (T07): thread.create makes a tab, a split or a new workspace and starts the harness in it
// with herdr agent.start; project.create makes a workspace.
const spawner = threadStore
  ? createSpawner({ store: threadStore, herdr, engine, queue: paneWrites, journals, audit })
  : null;

// v2 live modes (T08): thread.permissionMode.set cycles the harness's mode key and reads its footer;
// thread.model.set types the harness's model command through the same guarded send.
const liveModes = threadStore
  ? createLiveModes({ store: threadStore, sender: guardedSender, herdr, drainer: dispatcher?.drainer ?? null, audit })
  : null;

// v2 needs herdr >= 0.9.0 (T05). The version is asked once: right after the start-up ping below, or,
// if herdr is not answering then, when the link first comes up. Below the floor nothing ingests and
// every /api/v2/* route answers 503 with the reason; v1 is unaffected. A restart re-checks.
const v2Gate = createV2Gate();
if (threadStore) {
  v2Gate.whenOk(() => {
    console.log(`[threads] v2 on (herdr ${v2Gate.version()})`);
    herdIngestor?.start();
    journalIngestor?.start();
    requestIngestor?.start();
    dispatcher?.start();
  });
  engine.onLink((status) => {
    if (status === "connected" && v2Gate.state() === "pending") void v2Gate.check(herdr);
  });
}

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
} else if (threadStore) {
  await v2Gate.check(herdr);
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
  cfg, herdr, engine, notifications, push, notifyPrefs, settings, activity, lock, audit, conn,
  onEvents: (events) => { snapshotEvents = events; },
  journals,
  transcripts,
  paneWrites,
  v2: {
    store: threadStore,
    disabledReason: v2DisabledReason,
    gate: v2Gate,
    effects: {
      ...(requestIngestor ? { "runtime-request.respond": respondEffect(requestIngestor.respond) } : {}),
      ...(dispatcher?.effects ?? {}),
      ...(spawner?.effects ?? {}),
      ...(liveModes?.effects ?? {}),
    },
    watchers: threadWatchers,
    herdIngestor,
  },
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
  herdIngestor?.stop();
  journalIngestor?.stop();
  requestIngestor?.stop();
  dispatcher?.stop();
  poker.stop();
  // Retract anything still on the lock screen — nothing live stands behind it once we exit.
  notifications.clearAll();
  // Writes are debounced, so the last second or so of "you looked at this" lives only in memory —
  // persist it before exiting, or every restart quietly resurrects alerts you'd already cleared.
  activity.stop();
  await activity.flush();
  clearInterval(sweepTimer);
  clearInterval(pruneTimer);
  threadStore?.close();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) {
  try {
    process.on(signal, shutdown);
  } catch {
    // Some platforms do not support every signal (notably SIGBREAK and SIGHUP).
  }
}
