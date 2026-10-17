// What the operator sees when a render throws, instead of a blank app (there are no devtools on a phone).
// Used by RenderErrorBoundary (T3, verbatim) around the thread route and by the router's
// `defaultErrorComponent`. Reload starts the app again; Back leaves for the thread list.
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";

import { Button } from "~/components/ui/button";

export function ErrorFallback({ title = "Something went wrong", error }: { title?: string; error?: unknown }) {
  useEffect(() => {
    if (error !== undefined) console.error(error);
  }, [error]);
  return (
    <div role="alert" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-foreground">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">The rest of the app is fine. Reload to try again, or go back to your threads.</p>
      <div className="flex gap-2">
        <Button variant="outline" className="pointer-coarse:min-h-11" onClick={() => window.location.reload()}>
          Reload
        </Button>
        <Button variant="outline" className="pointer-coarse:min-h-11" render={<Link to="/" replace />}>
          Back
        </Button>
      </div>
    </div>
  );
}

/** The router's `defaultErrorComponent`: any route that throws while rendering or loading. */
export function RouteErrorFallback({ error }: { error: unknown }) {
  return <ErrorFallback error={error} />;
}
