import { createFileRoute, Link } from "@tanstack/react-router";

// An empty page until T18 (theme, display, push, lock devices, bridge settings, connection info).
export const Route = createFileRoute("/settings")({
  component: Settings,
});

function Settings() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3 p-4">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        Back to threads
      </Link>
      <h1 className="text-xl font-semibold">Settings</h1>
      <p className="font-mono text-xs text-muted-foreground">Build {__BUILD_INFO__.id}</p>
    </div>
  );
}
