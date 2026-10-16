import { createFileRoute, redirect } from "@tanstack/react-router";

import { useRightPanelStore } from "@/rightPanelStore";

/** v1's `/local` (an old bookmark): local servers are a section of the right panel's Files tab (T15). */
export const Route = createFileRoute("/local")({
  beforeLoad: () => {
    useRightPanelStore.getState().open("files");
    throw redirect({ to: "/", replace: true });
  },
});
