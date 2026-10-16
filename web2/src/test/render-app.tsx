import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, render } from "@testing-library/react";

import { getRouter } from "@/router";

/** Render the whole app (router, lock gate, shell stream) at a /v2/... path. */
export function renderApp(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = getRouter(history);
  const utils = render(<RouterProvider router={router} />);
  return { ...utils, router };
}

/** Run `fn` inside act() so store updates from fake stream frames flush to the DOM. */
export function frame(fn: () => void): void {
  act(fn);
}
