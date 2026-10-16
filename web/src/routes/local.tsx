import { RefreshCw } from "lucide-react";
import { useRouteLoaderData } from "react-router";

import { AppHeader } from "@/components/app-header";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { useLocalScan } from "@/lib/local-scan";
import { clockTime } from "@/lib/format";

function labelOf(name: string, port: number): string {
  return name || `port ${port}`;
}

/**
 * The Local destination: loopback listeners on this PC, each opened over the tailnet.
 *
 * No loader and no polling: the list is read when Scan is tapped (lib/local-scan.ts), and a server
 * is contacted only when its row is tapped.
 */
export function LocalRoute() {
  const home = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { scan, scanning, error, run } = useLocalScan();
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <AppHeader bridge={home.bridge} error={home.error} wordmark={false}>
        <span className="truncate font-semibold">Local</span>
      </AppHeader>
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {scan ? `Scanned ${clockTime(scan.at)}` : "Not scanned yet"}
        </span>
        <button
          type="button"
          onClick={run}
          disabled={scanning}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          <RefreshCw className={scanning ? "size-4 animate-spin" : "size-4"} />
          {scanning ? "Scanning…" : "Scan"}
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {error && <p className="px-4 py-3 text-sm text-destructive">{error}</p>}
        {!scan && !error && (
          <p className="px-4 py-3 text-sm text-muted-foreground">Tap Scan to list the servers listening on this PC.</p>
        )}
        {scan && !scan.host && (
          <p className="px-4 py-3 text-sm text-muted-foreground">Tailscale isn't running on this PC</p>
        )}
        {scan && scan.host && scan.servers.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">Nothing is listening on localhost.</p>
        )}
        {scan?.servers.map((server) => (
          <a
            key={server.port}
            href={`http://${scan.host}:${server.port}/`}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-3 border-b px-4 py-3 text-left"
          >
            <span className="min-w-0 flex-1 truncate">{labelOf(server.name, server.port)}</span>
            <span className="shrink-0 text-muted-foreground">:{server.port}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
