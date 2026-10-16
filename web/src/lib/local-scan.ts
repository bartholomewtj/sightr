import { useCallback, useEffect, useRef, useState } from "react";

import { fetchLocalServers, type LocalServer } from "@/lib/api";

/** One read of the PC's loopback listeners, with when it was taken. */
export interface LocalScan {
  host: string;
  servers: LocalServer[];
  /** Epoch ms of the read. Shown as a clock time, so a screen left open never shows a stale age. */
  at: number;
}

// The Local tab is the one screen that must not poll. Listing the ports shells out to PowerShell on
// the PC, so a list that re-read itself on every poll tick (1.5–4 s) cost a process spawn a tick for
// as long as the tab was open. The list is read only when the operator taps Scan. The last scan is
// kept on the phone so reopening the tab shows it without a request; the links are plain anchors,
// so a server is contacted only when its row is tapped.
const STORAGE_KEY = "sightr.local-scan";

export function readLastScan(): LocalScan | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<LocalScan>;
    if (typeof parsed.host !== "string" || !Array.isArray(parsed.servers) || typeof parsed.at !== "number") return undefined;
    return { host: parsed.host, servers: parsed.servers, at: parsed.at };
  } catch {
    return undefined;
  }
}

function rememberScan(scan: LocalScan): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scan));
  } catch {
    // Storage full or blocked: the scan still shows for this visit.
  }
}

/** One `GET /api/local-servers`, remembered on success. */
export async function scanLocalServers(signal?: AbortSignal): Promise<LocalScan> {
  const body = await fetchLocalServers(signal);
  const scan: LocalScan = { host: body.host, servers: body.servers, at: Date.now() };
  rememberScan(scan);
  return scan;
}

export interface LocalScanState {
  scan: LocalScan | undefined;
  scanning: boolean;
  error?: string;
  /** Run one scan. A tap while one is in flight is ignored. */
  run: () => void;
}

/** The Local screen's state: the last scan (if any), and a manual trigger. Never fetches on its own. */
export function useLocalScan(): LocalScanState {
  const [scan, setScan] = useState<LocalScan | undefined>(readLastScan);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  const run = useCallback(() => {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setScanning(true);
    setError(undefined);
    void scanLocalServers(controller.signal)
      .then((next) => { if (!controller.signal.aborted) setScan(next); })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Couldn't list local servers");
      })
      .finally(() => {
        if (inFlight.current !== controller) return;
        inFlight.current = null;
        if (!controller.signal.aborted) setScanning(false);
      });
  }, []);

  return { scan, scanning, error, run };
}
