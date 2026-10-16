import { createFileRoute } from "@tanstack/react-router";

import { NewThreadView } from "@/components/new-thread/NewThreadView";

type NewThreadSearch = { project?: string };

// The new-thread draft (T14). Same path as T3 Code's apps/web/src/routes/_chat.new.tsx; Sightr keeps one
// draft at a time, so there is no `/draft/$draftId`. `?project=` preselects a project (a sidebar row's
// "+", the palette's "New thread in …").
export const Route = createFileRoute("/_chat/new")({
  validateSearch: (search: Record<string, unknown>): NewThreadSearch =>
    typeof search.project === "string" && search.project !== "" ? { project: search.project } : {},
  component: NewThreadRoute,
});

function NewThreadRoute() {
  const { project } = Route.useSearch();
  return <NewThreadView {...(project ? { projectId: project } : {})} />;
}
