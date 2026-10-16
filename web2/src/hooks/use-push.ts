// Copied from web/src/hooks/use-push.ts, on web2's lib/push.ts. `usePushSetup` runs once the shell is
// open: it re-registers only a subscription web2 itself holds (see `reattachPush`), and never asks for
// permission (that needs a tap). `usePushControl` is Settings' switch.
import { useCallback, useEffect, useState } from "react";

import {
  disablePush,
  enablePush,
  getPushState,
  isPushDisabledByUser,
  pushSupported,
  reattachPush,
  type EnableResult,
  type PushState,
} from "@/lib/push";

export function usePushSetup(): void {
  useEffect(() => {
    if (isPushDisabledByUser() || !pushSupported() || Notification.permission !== "granted") return;
    let cancelled = false;
    void (async () => {
      try {
        await reattachPush();
      } catch (e) {
        if (!cancelled) console.warn("[push] setup skipped:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}

/** The push state plus an enable/disable action that refreshes it. */
export function usePushControl() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setState(await getPushState());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setEnabled = useCallback(
    async (enabled: boolean): Promise<EnableResult> => {
      setBusy(true);
      try {
        if (enabled) {
          let res: EnableResult;
          try {
            res = await enablePush();
          } catch {
            res = { ok: false };
          }
          await refresh();
          return res;
        }
        await disablePush();
        await refresh();
        return { ok: true };
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return { state, busy, setEnabled };
}
