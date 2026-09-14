import { useEffect, useRef } from "react";
import { useLoaderData, useLocation, useNavigate, useParams, useRouteLoaderData } from "react-router";
import { useBack } from "@/hooks/use-back";

import { AgentChat } from "@/components/agent-chat";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { homePath, panePath } from "@/lib/nav";
import { setStatus } from "@/lib/status";
import type { AgentView } from "@/lib/types";

// Pane detail route. Pane output comes from this route's loader; the pane's metadata comes from the
// shared snapshot (root loader). The pane may be an agent OR a bare shell. A just-created shell
// isn't in the snapshot yet, so we fall back to the `freshPane` passed via navigation state — the
// composer stays live immediately while polling catches the snapshot up. Keyed by paneId so
// switching panes remounts the composer fresh.
export function DetailRoute() {
  const pane = useLoaderData() as PaneData;
  const root = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { paneId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const stalled = useLoadingStalled();

  const navState = location.state as { freshPane?: AgentView; from?: string } | null;
  const fresh = navState?.freshPane;
  // The screen that opened this pane (Herd sets it; a deep link / notification / Spaces drill-in
  // doesn't). "‹" returns there, so the header back and the phone's back gesture agree.
  const from = navState?.from;
  const inSnapshot =
    root.agents.some((a) => a.paneId === paneId) ||
    root.shellPanes.some((p) => p.paneId === paneId);
  // The freshPane is a bootstrap only — used before a just-created pane first appears in a snapshot.
  // Once it's been seen, retire it; otherwise the stale copy masks a pane that has since closed
  // (e.g. you ran `exit` in its shell), stranding you on a dead view.
  //
  // Track *which* pane has been seen, not just a boolean: DetailRoute doesn't remount on a pane→pane
  // navigation (only `key={paneId}` on AgentChat does), so a lifetime boolean would carry the prior
  // pane's "seen" state onto a freshly-created one — disabling its freshPane fallback before the
  // snapshot catches up, so `gone` flips true and the effect below bounces you Home. That's the
  // "create a tab from inside an open pane sends me home" bug.
  const seenPaneId = useRef<string | null>(null);
  if (inSnapshot) seenPaneId.current = paneId;
  const seen = seenPaneId.current === paneId;

  const agent =
    root.agents.find((a) => a.paneId === paneId) ??
    root.shellPanes.find((p) => p.paneId === paneId) ??
    (fresh && fresh.paneId === paneId && !seen ? fresh : undefined);
  const tabLabel = root.tabs.find((t) => t.tabId === agent?.tabId)?.label;
  const gone = !agent;

  // "Up" from a pane is where you came from when we know it (`from`), else home — which IS the
  // spaces tree now, so the native stack shape survives the loss of the space detail route. The
  // `lastWorkspace` ref that used to remember a space for a just-closed pane went with that route:
  // there is no longer a per-space screen for it to land on.
  const upPath = () => from ?? homePath();
  // "‹" pops one history entry like the phone's back gesture; upPath is the cold-entry fallback only.
  const up = useBack(upPath());

  // Recover from a closed pane: once a healthy snapshot no longer has it, bounce up (to `from`, or
  // home)
  // instead of leaving you on a dead "agent gone" view. Guarded on a connected, non-stale snapshot
  // so a transient poll failure or reconnect doesn't evict a still-valid pane.
  useEffect(() => {
    if (gone && root.bridge === "connected" && !root.error) {
      setStatus("Pane closed", "info");
      navigate(upPath(), { replace: true });
    }
  }, [gone, root.bridge, root.error, navigate, from]);

  return (
    <AgentChat
      key={paneId}
      paneId={paneId}
      agent={agent}
      agents={root.agents}
      shellPanes={root.shellPanes}
      tabLabel={tabLabel}
      text={pane.text}
      requestedLines={pane.requestedLines}
      revision={pane.revision}
      device={root.device}
      bridge={root.bridge}
      error={root.error}
      stalled={stalled}
      onBack={up}
      // A pane→pane switch keeps `from`, so "‹" still returns to the screen you started from.
      onSelect={(id) => navigate(panePath(id), { state: { from } })}
    />
  );
}
