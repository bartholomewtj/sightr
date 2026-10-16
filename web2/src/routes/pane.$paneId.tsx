import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { findThreadByPane } from "@/lib/paneThread";
import { useShell } from "@/stream/stores";

/**
 * `/v2/pane/:paneId`: where a push notification lands (the bridge's payload names a pane, not a
 * thread). Finds the thread in the shell store and replaces itself with `/v2/thread/:id`; home with a
 * "Pane not found" notice when none matches. T15 reuses it for old v1 URLs.
 */
export const Route = createFileRoute("/pane/$paneId")({
  component: PaneRedirect,
});

function PaneRedirect() {
  const { paneId } = Route.useParams();
  const navigate = useNavigate();
  const loaded = useShell((s) => s.loaded);
  const threadId = useShell((s) => findThreadByPane(s.threads, paneId));

  useEffect(() => {
    if (threadId) void navigate({ to: "/thread/$threadId", params: { threadId }, replace: true });
    else if (loaded) void navigate({ to: "/", search: { notice: "pane-not-found" }, replace: true });
  }, [threadId, loaded, navigate]);

  return (
    <div role="status" className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      Opening…
    </div>
  );
}
