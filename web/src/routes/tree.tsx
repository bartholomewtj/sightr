import { useState } from "react";
import { useRevalidator, useRouteLoaderData } from "react-router";

import { AppHeader } from "@/components/app-header";
import { ReadOnlyBanner } from "@/components/read-only-banner";
import { SpaceTree } from "@/components/space-tree";
import { NewSpaceSheet } from "@/components/new-space-sheet";
import { StatusArea } from "@/components/status-area";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { useSpaceActions } from "@/hooks/use-spaces";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { isReadOnly } from "@/lib/types";
import { useDesktop } from "@/lib/desktop";

// The tree route: the Spaces tree at '/'. Everything spaces-and-tabs collapses into this folder tree.
export function TreeRoute() {
  const data = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const stalled = useLoadingStalled();
  const revalidator = useRevalidator();
  const { newSpace, newTab } = useSpaceActions();
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const desktop = useDesktop().on;

  if (desktop) return <div className="flex min-h-full items-center justify-center text-muted-foreground">Pick a pane</div>;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <AppHeader
        bridge={data.bridge}
        error={data.error}
        stalled={stalled}
        wordmark
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <ReadOnlyBanner device={data.device} />
        <main className="flex-1">
          <SpaceTree
            workspaces={data.workspaces}
            tabs={data.tabs}
            agents={data.agents}
            shellPanes={data.shellPanes}
            onNewSpace={() => setNewSpaceOpen(true)}
            onNewTab={newTab}
            readOnly={isReadOnly(data.device)}
            onRenamed={() => revalidator.revalidate()}
            error={data.error}
            lastSeenAt={data.lastSeenAt}
          />
        </main>
      </div>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-screen-sm px-3 pb-[calc(env(safe-area-inset-bottom)_+_4rem)]">
        <StatusArea />
      </div>

      <NewSpaceSheet open={newSpaceOpen} onClose={() => setNewSpaceOpen(false)} onCreate={newSpace} />
    </div>
  );
}
