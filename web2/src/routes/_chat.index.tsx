import { createFileRoute } from "@tanstack/react-router";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Sidebar } from "@/components/Sidebar";
import { SidebarToggle } from "@/components/shell/SidebarToggle";
import { useLayout } from "@/hooks/useLayout";
import { useUiState } from "@/uiStateStore";

type HomeSearch = { notice?: "pane-not-found" };

// Home: the thread list on a phone, "Pick a thread" on desktop (the sidebar is already beside it).
export const Route = createFileRoute("/_chat/")({
  validateSearch: (search: Record<string, unknown>): HomeSearch =>
    search.notice === "pane-not-found" ? { notice: "pane-not-found" } : {},
  component: Home,
});

function Home() {
  const { notice } = Route.useSearch();
  const desktop = useLayout() === "desktop";
  const sidebarOpen = useUiState((s) => s.sidebarOpen);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {notice === "pane-not-found" && (
        <p role="status" className="border-b bg-muted px-4 py-2 text-sm text-muted-foreground">
          Pane not found. It may have closed.
        </p>
      )}
      {desktop ? (
        <>
          {!sidebarOpen ? (
            <header className="flex h-10 items-center border-b px-3 py-2">
              <SidebarToggle />
            </header>
          ) : null}
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>Pick a thread</EmptyTitle>
              <EmptyDescription>Choose one from the list on the left.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </>
      ) : (
        <Sidebar />
      )}
    </div>
  );
}
