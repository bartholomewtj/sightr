import { ACTIVITY_KEY, type ActivityLedger } from "./activity.ts";
import type { Config } from "./config.ts";
import type { Push } from "./push.ts";
import type { LockStore } from "./lock.ts";
import {
  lockGate,
  lockStatusRoute,
  lockClearAllRoute,
  webauthnChallengeRoute,
  webauthnUnlockRoute,
  webauthnRegisterRoute,
  webauthnRemoveRoute,
} from "./lock-routes.ts";
import { createChallenges } from "./webauthn.ts";

import type { NotifyPrefsStore } from "./notify-prefs.ts";
import { settingsRoute, type RuntimeSettingsStore } from "./runtime-settings.ts";
import { createOperatorCommands } from "./operator-commands.ts";
import { createOperatorKeys, createOperatorWheel } from "./operator-keys.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { NotificationCoordinator } from "./notifications.ts";
import type { StateEngine } from "./state-engine.ts";
import { createSssfViz } from "./sssf-viz.ts";
import { createWorkdir } from "./workdir.ts";
import { adapterFor, buildJournalRegistry } from "./journal/registry.ts";
import { TranscriptStore } from "./journal/store.ts";

import { isLoopbackPeer, marksPaneSeen, guard, startupWarnings, isHostAllowed, deviceAuth } from "./access.ts";
import type { AuditLog } from "./audit.ts";
import { CONTENT_TYPES, CSP, json, requireJsonBody, secure, text, failureText, decodePathSegment } from "./responses.ts";
import { serveStatic, isReservedAuthPath, resolveStaticPath, cacheControlFor, reservedAuthPlaceholder } from "./static-assets.ts";
import { readPane, paneHistory } from "./pane-read-routes.ts";
import { replyPane, keysPane, closePane, renamePane, uploadPane } from "./pane-write-routes.ts";
import { renameTab, renameWorkspace, closeTab, closeWorkspace, createTab, createWorkspace, removeWorktree, openWorktree } from "./tree-routes.ts";
import { createWorktreeIndex } from "./worktrees.ts";
import { snapshotRoute, bridgeConfigRoute } from "./snapshot-route.ts";
import { createSnapshotEvents, eventsRoute, type SnapshotEvents } from "./events-route.ts";
import { subscribeRoute, notifyPrefsRoute } from "./notify-routes.ts";
import { createPaneQueue } from "./pane-queue.ts";

const MAX_REQUEST_BODY_BYTES = 12 * 1024 * 1024;
const PANE_ROUTE = /^\/api\/pane\/([^/]+)(?:\/(reply|keys|upload|close|rename|history))?$/;
const TAB_ACTION_ROUTE = /^\/api\/tab\/([^/]+)\/(rename|close)$/;
const WORKSPACE_ACTION_ROUTE = /^\/api\/workspace\/([^/]+)\/(rename|close)$/;
const WORKTREE_REMOVE_ROUTE = /^\/api\/workspace\/([^/]+)\/worktree\/remove$/;

export function startServer(opts: {
  cfg: Config;
  herdr: HerdrClient;
  engine: StateEngine;
  notifications: NotificationCoordinator;
  push: Push;
  notifyPrefs: NotifyPrefsStore;
  settings: RuntimeSettingsStore;
  activity: ActivityLedger;
  lock: LockStore;
  audit: AuditLog;
  onEvents?: (events: SnapshotEvents) => void;
}) {
  const { cfg, herdr, engine, notifications, push, notifyPrefs, settings, activity, lock, audit } = opts;
  const snapshotDeps = () => ({ cfg, engine, activity, sssfViz, workdir, worktrees, journals, transcripts, offerHistory });
  let events!: SnapshotEvents;
  events = createSnapshotEvents(async () => {
    const request = new Request("http://localhost/api/snapshot", { headers: { host: "localhost" } });
    return (await snapshotRoute(request, snapshotDeps())).text();
  });
  opts.onEvents?.(events);
  const challenges = createChallenges();
  // One per-pane write queue for the whole process: two panes never wait on each other.
  const paneWrites = createPaneQueue();
  // One journal registry + store for the process. The store's cache is keyed by absolute path, so
  // sharing it across harnesses is correct. Which harnesses have journals at all is decided in
  // journal/registry.ts, never here.
  // One reader per process; it owns the mtime cache that keeps commands.toml off the hot path.
  const operatorCommands = createOperatorCommands(cfg.commandsFile);
  const operatorKeys = createOperatorKeys(cfg.keysFile);
  const operatorWheel = createOperatorWheel(cfg.keysFile);
  const journals = cfg.transcript ? buildJournalRegistry(cfg.journalRoots, cfg.stateDir) : null;
  const transcripts = cfg.transcript ? new TranscriptStore() : null;
  // Grok (and any future cwd-keyed harness) can offer history without Herdr naming a session.
  const offerHistory = (agent: string, hasSessionRef: boolean) => {
    const adapter = adapterFor(journals ?? {}, agent);
    return adapter !== undefined && (hasSessionRef || typeof adapter.inferFromCwd === "function");
  };
  // The SSSF traces tab (bridge/sssf-viz.ts). Inert unless SSSF_VIZ_DIR is set; it borrows the
  // gate/static helpers below rather than importing this file back.
  const sssfViz = createSssfViz(cfg, {
    guard, isHostAllowed, requireJsonBody, failureText, resolveStaticPath, cacheControlFor, secure,
    csp: CSP, contentTypes: CONTENT_TYPES,
  });
  // One line per write, attributed to the device the request cleared the gate as. Only called inside
  // a write branch, so a read costs nothing.
  const auditFor = (req: Request): AuditLog => audit.scoped({ device: deviceAuth(req, cfg).device });

  const worktrees = createWorktreeIndex(herdr);
  const workdir = createWorkdir(cfg, { guard, json, text, failureText, secure, contentTypes: CONTENT_TYPES, requireJsonBody, auditFor, paneCwd: (paneId) => {
    const { agents, shellPanes } = engine.current();
    return [...agents, ...shellPanes].find((p) => p.paneId === paneId)?.cwd ?? null;
  } });
  // Background notifications are wired to the StateEngine's transitions in index.ts. The routes here
  // only apply preference changes to that coordinator.

  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    // Runtime cap on any request body — a chunked/lying client is cut off here even if its
    // Content-Length is absent or false. The upload handler still does its own precise check.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,

    // Bun's `development` default is `NODE_ENV !== "production"`, and nothing in Sightr's launch paths
    // sets NODE_ENV — so without this the bridge served Bun's HTML error page, stack trace and absolute
    // source paths included, to anyone who could make a handler throw. Pinned in code rather than via a
    // unit Environment= line because the three launch paths in sightr-ctl.ps1 plus the hand-maintained
    // systemd/sightr.service copy would all have to agree, and nothing tests that they do.
    development: false,

    // Folder zip planning walks up to 2000 files before the first response byte. Bun's default
    // 10s idleTimeout closes that socket; Chrome then names the failed download `download.txt`.
    idleTimeout: 120,

    // Last line of defence: anything that escapes `fetch` (or a rejected promise a handler returned)
    // lands here instead of Bun's default page. `text()` applies the shared hardening headers, which a
    // raw `new Response` here would skip.
    error(err: unknown) {
      return text(failureText("request", err), 500);
    },

    async fetch(req, srv) {
      // Peer-address gate, ahead of routing so it covers the static PWA too. Under the loopback bind
      // that config.ts enforces this can never fire; it exists so a wide bind reached some other way
      // (a container port-forward, a future bind path, a hand-edited unit) still can't reach a route.
      // Skipped when the operator explicitly opted into a wide bind — there, remote peers are the point.
      if (!cfg.allowNonLoopbackBind && !isLoopbackPeer(srv.requestIP(req)?.address)) {
        return text("non-loopback peer rejected", 403);
      }

      const url = new URL(req.url);
      const { pathname } = url;
      const gated = lockGate(req, url, cfg, lock, sssfViz.owns, sssfViz.lockExempt);
      if (gated) return gated;

      if (sssfViz.owns(pathname)) return sssfViz.handle(req, url);
      if (workdir.owns(pathname)) return workdir.handle(req, url);

      if (pathname === "/api/snapshot") return snapshotRoute(req, snapshotDeps());
      if (pathname === "/api/events" && req.method === "GET") return eventsRoute(req, snapshotDeps(), events);

      // ── Structural creates: new tab / new space (each opens a fresh shell pane) ──
      if (pathname === "/api/tab" && req.method === "POST") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        return createTab(herdr, engine, req, auditFor(req));
      }
      if (pathname === "/api/workspace" && req.method === "POST") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        return createWorkspace(herdr, req, worktrees, auditFor(req));
      }

      // ── Tab actions: rename (set its label) / close (kill it + every pane in it) ──
      const tabMatch = pathname.match(TAB_ACTION_ROUTE);
      if (tabMatch && req.method === "POST") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        const tabId = decodePathSegment(tabMatch[1]!);
        if (tabId === null) return text("bad tab id", 400);
        const action = tabMatch[2];
        if (action === "close") return closeTab(herdr, tabId, req, auditFor(req));
        return renameTab(herdr, tabId, req, auditFor(req));
      }

      // ── Space (workspace) actions: rename / close (Herdr's own close, plus worktree group). ──
      const wsMatch = pathname.match(WORKSPACE_ACTION_ROUTE);
      if (wsMatch && req.method === "POST") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        const workspaceId = decodePathSegment(wsMatch[1]!);
        if (workspaceId === null) return text("bad workspace id", 400);
        const action = wsMatch[2];
        if (action === "close") return closeWorkspace(herdr, workspaceId, req, worktrees, auditFor(req));
        return renameWorkspace(herdr, workspaceId, req, auditFor(req));
      }

      const wtRemove = pathname.match(WORKTREE_REMOVE_ROUTE);
      if (wtRemove && req.method === "POST") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        const workspaceId = decodePathSegment(wtRemove[1]!);
        if (workspaceId === null) return text("bad workspace id", 400);
        return removeWorktree(herdr, workspaceId, req, worktrees);
      }
      if (pathname === "/api/worktree/open" && req.method === "POST") {
        const denied = guard(req, cfg, "write");
        if (denied) return denied;
        return openWorktree(herdr, req, worktrees);
      }

      // ── Per-pane read / send ─────────────────────────────────────────────
      const paneMatch = pathname.match(PANE_ROUTE);
      if (paneMatch) {
        const action = paneMatch[2];
        // Reading a pane is allowed for any access-gated client; every action (reply/keys/upload/
        // close) types into or restructures a terminal, so it additionally needs an authorised device.
        // `history` is a READ despite being an action segment — it only ever reads a log off disk.
        const isRead = !action || action === "history";
        const denied = guard(req, cfg, isRead ? "read" : "write");
        if (denied) return denied;
        const paneId = decodePathSegment(paneMatch[1]!);
        if (paneId === null) return text("bad pane id", 400);
        // You are in this pane: reading it, replying, sending keys, browsing its history. That is
        // the whole definition of "seen" (.adr/0003), and this is the one place every such request
        // passes through. It cannot false-positive from background polling — the dashboard loader
        // only ever fetches /api/snapshot; paneLoader is the sole reader of pane text — nor from a
        // cross-site request forged at a guessed pane id (see marksPaneSeen).
        //
        // Gated on the request actually being ROUTED below. PANE_ROUTE constrains `action` to the
        // known set, so the only way to reach here unrouted is a method mismatch (a GET at /reply, a
        // POST at /history) — which 405s. Without this a malformed request still marked the pane seen.
        const routed = isRead ? req.method === "GET" : req.method === "POST";
        if (routed && marksPaneSeen(req, action)) { activity.noteSeen(ACTIVITY_KEY, paneId); events.notify(); }

        if (!action && req.method === "GET") return readPane(herdr, cfg, paneId, url, req);
        if (action === "history" && req.method === "GET")
          return paneHistory(cfg, journals, transcripts, engine, herdr, paneId, url, req);
        if (action === "reply" && req.method === "POST") return replyPane(herdr, cfg, paneId, req, paneWrites, auditFor(req));
        if (action === "keys" && req.method === "POST") return keysPane(herdr, cfg, paneId, req, paneWrites, auditFor(req));
        if (action === "upload" && req.method === "POST") return uploadPane(cfg, paneId, req, auditFor(req));
        if (action === "close" && req.method === "POST") return closePane(herdr, paneId, req, paneWrites, auditFor(req));
        if (action === "rename" && req.method === "POST") return renamePane(herdr, paneId, req, paneWrites, auditFor(req));
        return text("method not allowed", 405);
      }

      // ── Misc API ─────────────────────────────────────────────────────────
      if (pathname === "/api/lock" && req.method === "GET") return lockStatusRoute(req, url, cfg, lock);
      if (pathname === "/api/lock/clear-all" && req.method === "POST") return lockClearAllRoute(req, url, cfg, lock, auditFor(req));
      if (pathname === "/api/lock/webauthn/challenge" && req.method === "POST") return webauthnChallengeRoute(req, url, cfg, lock, challenges);
      if (pathname === "/api/lock/webauthn/unlock" && req.method === "POST") return webauthnUnlockRoute(req, url, cfg, lock, challenges);
      if (pathname === "/api/lock/webauthn/register" && req.method === "POST") return webauthnRegisterRoute(req, url, cfg, lock, challenges, auditFor(req));
      if (pathname === "/api/lock/webauthn/remove" && req.method === "POST") return webauthnRemoveRoute(req, url, cfg, lock, auditFor(req));
      if (pathname === "/api/config") return bridgeConfigRoute(req, { cfg, push, operatorCommands, operatorKeys, operatorWheel });
      if (pathname === "/api/subscribe" && req.method === "POST") return subscribeRoute(req, cfg, push);
      if (pathname === "/api/notifications/prefs") return notifyPrefsRoute(req, cfg, notifyPrefs, notifications);
      if (pathname === "/api/settings") {
        const denied = guard(req, cfg, req.method === "GET" ? "read" : "write");
        if (denied) return denied;
        return settingsRoute(req, cfg, settings, auditFor(req));
      }

      // ── Reserved for a fronting proxy's sign-in page ─────────────────────
      // `/auth/` is the one path the service worker always passes to the network (web/src/lib/
      // sw-routes.ts), so it is the only address an installed PWA can reach when a proxy in front of
      // the bridge refuses a stale session. Sightr never routes it. If a request gets this far, no
      // proxy claimed it — say so, instead of letting the SPA fallback answer with the app shell and
      // leave the operator staring at the UI they were trying to escape.
      if (isReservedAuthPath(pathname)) return reservedAuthPlaceholder();

      // ── Static PWA (with SPA fallback) ───────────────────────────────────
      return serveStatic(pathname, req.headers.get("host") ?? "", cfg);
    },
  });

  console.log(
    `[bridge] listening on http://${cfg.host}:${cfg.port} (poll ${cfg.pollMs}ms, ` +
      `lock ${lock.enabled() ? "on" : "off"}, ` +
      `device-auth ${cfg.deviceHeader ? `on/${cfg.deviceAllowlist.length} allowed` : "off"})`,
  );
  for (const w of new Set(startupWarnings(cfg))) console.warn(w);

  return server;
}
