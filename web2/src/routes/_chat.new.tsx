import { createFileRoute } from "@tanstack/react-router";

// T14 builds the new-thread draft (project, harness, model, mode).
export const Route = createFileRoute("/_chat/new")({
  component: NewThread,
});

function NewThread() {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
      Starting a thread from Sightr v2 is not ready yet.
    </div>
  );
}
