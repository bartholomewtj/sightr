import { createRouter, type RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

/** web2 lives under /v2/ until cutover (T15); every route path below is relative to it. */
export const BASEPATH = "/v2";

export function getRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    basepath: BASEPATH,
    ...(history ? { history } : {}),
    context: {},
    defaultPreload: "intent",
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
