// Adapted from T3 Code apps/web/src/components/ThreadNotificationCoordinator.tsx @ db5919d87 (MIT, see THIRD_PARTY.md).
// Kept from T3: watch every thread's status, alert on a change into approval, input, failed or finished,
// never for the open thread, and show an in-app toast with an "Open" action. Dropped: Effect atoms,
// per-environment loops, the sound and the desktop `Notification` (Sightr's bridge sends Web Push for a
// hidden app). Added: the app-icon badge (the "Needs you" count) and a per-device switch.
//
// Why it exists: the service worker drops a push while any Sightr window is visible (`decidePush`), and on
// a phone the sidebar is off screen inside a thread, so thread B needing approval raised nothing.
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useInAppAlerts } from "@/hooks/use-alert-prefs";
import { useLayout } from "@/hooks/useLayout";
import { useShell } from "@/stream/stores";
import { showToast } from "@/components/toast";

import { alertText, needsYouCount, planThreadAlerts, setAppBadge, type AlertStatus } from "./ThreadNotificationCoordinator.logic";

export function ThreadNotificationCoordinator() {
  const loaded = useShell((s) => s.loaded);
  const threads = useShell((s) => s.threads);
  const enabled = useInAppAlerts();
  const navigate = useNavigate();
  const phone = useLayout() === "phone";
  const openThreadId = useRouterState({
    select: (s) => (s.matches.at(-1)?.params as { threadId?: string } | undefined)?.threadId ?? null,
  });
  // On a phone the thread list is the whole screen: its dots already say it.
  const onList = useRouterState({ select: (s) => s.matches.some((m) => m.routeId === "/_chat/") });
  const quiet = phone && onList;

  const previous = useRef<Map<string, AlertStatus | null> | null>(null);
  const raised = useRef<Set<string>>(new Set());
  // The latest route facts, read when the threads change, without re-planning on every navigation.
  const context = useRef({ openThreadId, quiet, enabled });
  context.current = { openThreadId, quiet, enabled };

  useEffect(() => {
    if (!loaded) return;
    const plan = planThreadAlerts({ previous: previous.current, raised: raised.current, threads: Object.values(threads), openThreadId: context.current.openThreadId });
    previous.current = plan.next;
    raised.current = plan.raised;
    // A hidden app gets the Web Push instead.
    if (!context.current.enabled || context.current.quiet || document.visibilityState !== "visible") return;
    for (const alert of plan.alerts) {
      showToast(alertText(alert), alert.status === "failed" ? "error" : "info", {
        key: `alert:${alert.threadId}`,
        action: { label: "Open", onClick: () => void navigate({ to: "/thread/$threadId", params: { threadId: alert.threadId } }) },
      });
    }
  }, [loaded, threads, navigate]);

  useEffect(() => {
    if (!loaded) return;
    setAppBadge(enabled ? needsYouCount(Object.values(threads)) : 0);
  }, [loaded, threads, enabled]);

  return null;
}
