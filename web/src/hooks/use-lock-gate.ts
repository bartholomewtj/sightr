import { useEffect, useState } from "react";
import { fetchLockStatus } from "@/lib/api";
import { clearLockRequired, useLockRequired } from "@/lib/lock";
export type LockGate = { status: "loading" } | { status: "locked" } | { status: "open" };
export function useLockGate(): { gate: LockGate; onUnlocked: () => void } {
  const required = useLockRequired(); const [gate, setGate] = useState<LockGate>({ status: "loading" });
  useEffect(() => { fetchLockStatus().then(s => setGate(s.enabled && !s.unlocked ? { status: "locked" } : { status: "open" })).catch(() => setGate({ status: "open" })); }, []);
  useEffect(() => { if (required) setGate({ status: "locked" }); }, [required]);
  return { gate, onUnlocked: () => { clearLockRequired(); setGate({ status: "open" }); } };
}
