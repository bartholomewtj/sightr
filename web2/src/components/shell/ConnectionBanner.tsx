import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { CONNECTION_LOST_MS, TROUBLE_MS } from "@/stream/health";
import { shellStream } from "@/stream/shell-stream";
import { useStreamHealth } from "@/stream/stores";

export type BannerState = "hidden" | "reconnecting" | "lost";

/** What the banner shows `elapsed` ms after the stream stopped being live (v1's thresholds). */
export function bannerState(status: "connecting" | "live" | "lost", elapsed: number): BannerState {
  if (status === "live") return "hidden";
  if (status === "lost" || elapsed >= CONNECTION_LOST_MS) return "lost";
  if (elapsed >= TROUBLE_MS) return "reconnecting";
  return "hidden";
}

/**
 * The one connection surface, in flow at the top of the shell: nothing while live, a quiet
 * "Reconnecting…" after 4 s, warn "Not connected" with Retry after 15 s.
 */
export function ConnectionBanner({ onRetry }: { onRetry?: () => void }) {
  const status = useStreamHealth((s) => s.status);
  const downSince = useStreamHealth((s) => s.downSince);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status === "live") return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [status]);

  const state = bannerState(status, now - downSince);
  if (state === "hidden") return null;
  if (state === "reconnecting") {
    return (
      // tokens.md has no amber: the quiet step is navy chrome, and warn is kept for "not connected".
      <div role="status" className="border-b border-border bg-muted px-4 py-1.5 text-sm text-info">
        Reconnecting…
      </div>
    );
  }
  return (
    <div role="alert" className="flex items-center gap-3 border-b border-destructive/40 bg-error-surface px-4 py-1.5 text-sm text-destructive">
      <span className="flex-1">Not connected. Check the connection to the host.</span>
      <Button size="xs" variant="outline" onClick={onRetry ?? (() => shellStream().reconnectNow())}>
        Retry
      </Button>
    </div>
  );
}
