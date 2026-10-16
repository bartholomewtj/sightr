// Copied from web/src/hooks/use-notify-prefs.ts: the bridge-wide notification types. Loads once; a
// toggle is optimistic (flip, POST the one key, reconcile with the merged reply, revert on failure).
import { useCallback, useEffect, useState } from "react";

import type { NotifyPrefs } from "@shared/wire";
import { showToast } from "@/components/toast";
import { getNotifyPrefs, isApiErrorStatus, setNotifyPrefs } from "@/lib/api";

export function useNotifyPrefs() {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getNotifyPrefs()
      .then((p) => alive && setPrefs(p))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback(async (key: keyof NotifyPrefs, next: boolean) => {
    setPrefs((prev) => (prev ? { ...prev, [key]: next } : prev));
    setBusy(true);
    try {
      setPrefs(await setNotifyPrefs({ [key]: next }));
    } catch (err) {
      setPrefs((prev) => (prev ? { ...prev, [key]: !next } : prev));
      showToast(
        isApiErrorStatus(err, 403)
          ? "Read-only — this device isn't authorised to change notification settings"
          : "Couldn't change notification preferences",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  return { prefs, busy, toggle };
}
