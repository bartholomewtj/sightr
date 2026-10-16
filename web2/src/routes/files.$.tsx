import { createFileRoute, redirect } from "@tanstack/react-router";

import { useRightPanelStore } from "@/rightPanelStore";

/**
 * v1's `/files` and `/files/*` (old bookmarks, the installed app's last screen). v2 keeps files in the
 * right panel beside a thread, so this opens that panel's Files tab and goes home (T15 deep links).
 */
export const Route = createFileRoute("/files/$")({
  beforeLoad: () => {
    useRightPanelStore.getState().open("files");
    throw redirect({ to: "/", replace: true });
  },
});
