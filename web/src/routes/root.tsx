import { Outlet, useLoaderData, useLocation, useParams, useRouteError, useRouteLoaderData } from "react-router";

import { usePolling } from "@/hooks/use-polling";
import { usePollBusy } from "@/hooks/use-poll-busy";
import { useAgentTransitions } from "@/hooks/use-transitions";
import { usePushSetup } from "@/hooks/use-push";
import { useConnectionLost } from "@/hooks/use-connection-lost";
import { ConnectionBanner } from "@/components/connection-banner";
import { SightrMark } from "@/components/dog-gallop";
import { BottomNav } from "@/components/bottom-nav";
import { DesktopShell } from "@/components/desktop-shell";
import { useDesktop } from "@/lib/desktop";
import { homePath } from "@/lib/nav";
import { PANE_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { bucketOf } from "@/lib/triage";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

/**
 * The "last seen" stamp the connection surface should show — the stamp of the data actually on
 * screen. While a stale pane mirror is what's being read, that pane's stamp wins (undated included);
 * otherwise the herd's. A stale pane with no text falls through — nothing old is on screen.
 */
export function shownLastSeenAt(home: HomeData, pane: PaneData | undefined): number | undefined {
  if (pane?.error && pane.text) return pane.lastSeenAt;
  return home.lastSeenAt;
}

// The data root: owns the snapshot loader, drives polling, and fans the herd out to the child
// routes via the router's loader data. Mounted for the lifetime of the route tree, so polling follows the active screen.
export function RootLayout() {
  const data = useLoaderData() as HomeData;
  // useParams accumulates params from matched child routes, so `paneId` is set when the
  // `/pane/:paneId` child is active. useAgentTransitions uses it to suppress a notification for the
  // pane you're already looking at.
  const { paneId } = useParams();
  const pane = useRouteLoaderData(PANE_ROUTE_ID) as PaneData | undefined;

  usePolling(data, paneId);
  // Surface the busy bar when a navigation or a poll runs slow, each against its own threshold —
  // routine fast polls/navigations stay invisible. Mounted here so the whole app shares one
  // detector inside the router context.
  usePollBusy();
  useAgentTransitions(data.agents, paneId ?? null);
  usePushSetup(data.device);

  // The bottom bar shows on the top-level destinations (Spaces tree, Files, Settings).
  // A pane, a file preview, and history are leaf screens that own the bottom
  // edge (composer, frame) and get a header back button instead.
  const { pathname } = useLocation();
  const showNav = pathname === "/" || pathname === "/files" || pathname === "/settings";
  const desktop = useDesktop().on;
  useEffect(() => {
    if (!desktop) return;
    const needs = data.agents.filter((agent) => bucketOf(agent) === "needs").length;
    document.title = needs > 0 ? `(${needs}) Sightr` : "Sightr";
  }, [desktop, data.agents]);

  // A viewport-height flex column: the top banners (when shown) are in-flow rows at the top and the
  // active route fills the rest (each route root is `min-h-0 flex-1`). This is what keeps a banner
  // from covering the route's sticky header — it reserves real space instead of overlaying.
  return (
    <div className={cn("flex h-[100dvh] flex-col", desktop && "overflow-hidden")}>
      {/* The app's ONE connection surface: a thin, animated bar that stays hidden while healthy, fades
          in amber "reconnecting…" only after ≥4s of sustained trouble (the flicker fix), escalates to a
          red "not connected" cause + Retry/Reload at ≥15s, and flashes green on recovery. Reads the
          same shared-clock signals as the header mark, so the two always agree. */}
      <ConnectionBanner
        bridge={data.bridge}
        error={data.error}
        authError={data.authError}
        lastSeenAt={shownLastSeenAt(data, pane)}
      />
      {desktop ? (
        <DesktopShell />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </div>
      )}
      {!desktop && showNav && <BottomNav files={data.files === true} />}
    </div>
  );
}

// Shown once, on the very first load, while the snapshot loader resolves (SPA hydration). This is the
// router's HydrateFallback, so it stays mounted until the FIRST loader run settles — and over a dead
// tailnet that initial fetch can hang well past its timeout (or forever on a WebView without
// AbortSignal.timeout). Left as-is, a PWA reopened while the host is unreachable would run the
// loader on "Connecting to the herd…" indefinitely, with no way to retry. So once we've been stuck
// here for CONNECTION_LOST_MS (the same wall-clock threshold as the in-app prompt — `connecting` is
// trivially true the whole time we're mounted), the splash escalates to an honest, actionable "Not
// connected" state: the mark rests, the copy says we can't reach Sightr, and a Retry re-runs the
// loaders from scratch (a full reload clears most transient failures). Below the threshold it's
// unchanged.
export function BootSplash() {
  const stuck = useConnectionLost(true);
  if (!stuck) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 text-muted-foreground">
        {/* Same knockout loader as index.html's first-paint splash — cream disk, navy bison. */}
        <span role="img" aria-label="Loading" className="size-16">
          <img src="/sightr-loading-badge.svg" alt="" aria-hidden="true" className="hidden size-full dark:block" />
          <img src="/sightr-loading-badge-light.svg" alt="" aria-hidden="true" className="size-full dark:hidden" />
        </span>
        <span className="text-sm">Connecting to the herd…</span>
      </div>
    );
  }
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 p-6 text-center">
      {/* Rest = the static badge, muted to read asleep. The "Not connected" copy below carries the
          accessible meaning, so the icon is decorative. */}
      <SightrMark className="size-16" muted />
      <p className="font-medium text-foreground">Not connected</p>
      <p className="max-w-xs text-sm text-muted-foreground">
        Can&rsquo;t reach Sightr — check your connection to the host, then try again.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="text-sm underline underline-offset-4"
      >
        Retry
      </button>
    </div>
  );
}

// Last-resort recovery screen for a render-phase error or a loader throw — a full reload re-runs the
// loaders from scratch, which clears most transient failures.
export function RootError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "Unknown error";
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="font-medium text-destructive">Something went wrong</p>
      <p className="max-w-xs text-sm text-muted-foreground">{message}</p>
      <button
        type="button"
        onClick={() => {
          window.location.assign(homePath());
        }}
        className="text-sm underline underline-offset-4"
      >
        Reload
      </button>
    </div>
  );
}
