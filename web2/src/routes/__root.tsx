import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";

import { LockPrompt } from "@/components/LockPrompt";
import { ConnectionBanner } from "@/components/shell/ConnectionBanner";
import { V2Unavailable } from "@/components/shell/V2Unavailable";
import { useLockGate } from "@/hooks/useLockGate";
import { shellStream } from "@/stream/shell-stream";
import { useStreamHealth } from "@/stream/stores";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

/** Owns the lock gate and, once it is open, the shell stream. */
function RootLayout() {
  const { gate, onUnlocked } = useLockGate();
  if (gate.status === "loading") {
    return (
      <div role="status" className="flex h-[100dvh] items-center justify-center text-sm text-muted-foreground">
        Connecting to the herd…
      </div>
    );
  }
  if (gate.status === "locked") return <LockPrompt onUnlocked={onUnlocked} />;
  return <OpenShell />;
}

function OpenShell() {
  useEffect(() => {
    const stream = shellStream();
    stream.start();
    return () => stream.stop();
  }, []);
  const blocked = useStreamHealth((s) => s.blocked);
  if (blocked) return <V2Unavailable blocked={blocked} />;

  // A 100dvh column: the banner is an in-flow row at the top, the route fills the rest.
  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden pt-safe pl-safe pr-safe">
      <ConnectionBanner />
      <div className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-foreground">Nothing here.</p>
      <Link to="/" className="text-sm text-muted-foreground underline underline-offset-4">
        Back to threads
      </Link>
    </div>
  );
}
