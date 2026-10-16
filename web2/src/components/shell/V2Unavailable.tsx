import type { V2Blocked } from "@/stream/stores";

/**
 * Full screen, not a banner over an empty app: the bridge refuses every v2 call on this host. The
 * shell stream keeps retrying once a minute and this screen goes away by itself when the bridge
 * answers 200 (T09, T05 herdr floor).
 */
export function V2Unavailable({ blocked }: { blocked: V2Blocked }) {
  const headline =
    blocked.code === "herdr-too-old"
      ? `Sightr v2 needs herdr ${blocked.need ?? "0.9.0"} or newer. This host runs ${blocked.have ?? "an older version"}.`
      : "Sightr v2 is turned off on this bridge.";
  return (
    <main className="flex h-[100dvh] flex-col items-center justify-center gap-4 p-6 text-center pt-safe pb-safe">
      <h1 className="max-w-md text-lg font-semibold text-foreground">{headline}</h1>
      {blocked.error && <p className="max-w-md font-mono text-sm text-muted-foreground">{blocked.error}</p>}
      <p className="max-w-md text-sm text-muted-foreground">This page checks again every minute.</p>
      {/* A plain link: v1 lives outside the /v2 router basepath. */}
      <a href="/" className="rounded-lg border border-input bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-accent">
        Open Sightr v1
      </a>
    </main>
  );
}
