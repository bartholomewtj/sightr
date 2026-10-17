import { createRouter, type RouterHistory } from "@tanstack/react-router";

import { RouteErrorFallback } from "./components/shell/ErrorFallback";
import { routeTree } from "./routeTree.gen";

/** The router basepath for vite's `base`: `/` → "/", `/v2/` → "/v2". Pure + exported for tests. */
export function basepathFor(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * web2 is served at `/` since the T15 cutover (vite `base`); every route path is relative to it. Tests
 * and a `vite dev` preview may use `/v2/`.
 */
export const BASEPATH = basepathFor(import.meta.env.BASE_URL);

export function getRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    basepath: BASEPATH,
    ...(history ? { history } : {}),
    context: {},
    defaultPreload: "intent",
    // A route that throws shows Reload and Back, not a blank app.
    defaultErrorComponent: RouteErrorFallback,
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
