import { useLoaderData, useRouteLoaderData } from "react-router";

import { AppHeader } from "@/components/app-header";
import { ROOT_ROUTE_ID, type HomeData, type LocalData } from "@/lib/loaders";

function labelOf(name: string, port: number): string {
  return name || `port ${port}`;
}

/** The Local destination: loopback listeners on this PC, each opened over the tailnet. */
export function LocalRoute() {
  const loaded = useLoaderData() as LocalData;
  const home = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <AppHeader bridge={home.bridge} error={home.error} wordmark={false}>
        <span className="truncate font-semibold">Local</span>
      </AppHeader>
      <div className="flex-1 overflow-auto">
        {!loaded.host && (
          <p className="px-4 py-3 text-sm text-muted-foreground">Tailscale isn't running on this PC</p>
        )}
        {loaded.host && loaded.servers.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">Nothing is listening on localhost.</p>
        )}
        {loaded.servers.map((server) => (
          <a
            key={server.port}
            href={`http://${loaded.host}:${server.port}/`}
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
