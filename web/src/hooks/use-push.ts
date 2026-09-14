import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import {
  disablePush,
  enablePush,
  reattachPush,
  getPushState,
  getPushDevice,
  isPushDisabledByUser,
  notePushDevice,
  pushSupported,
  subscribePushDevice,
  type EnableResult,
  type PushState,
} from "@/lib/push";
import type { DeviceAuth } from "@/lib/types";

// Publish the loaded snapshot to the App-level onboarding cover, then silently re-attach push only
// when the browser has already granted permission. Permission requests must come from a user tap.
export function usePushSetup(device?: DeviceAuth) {
  useEffect(() => {
    notePushDevice(device);
  }, [device]);

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

export function usePushDevice(): { seen: boolean; readOnly: boolean } {
  return useSyncExternalStore(subscribePushDevice, getPushDevice, getPushDevice);
}

// Settings-page controller: the current push state plus an enable/disable action that refreshes it.
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
          const res = await enablePush();
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
