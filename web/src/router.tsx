import { createBrowserRouter } from "react-router";

import { BootSplash, RootError, RootLayout } from "@/routes/root";
import { TreeRoute } from "@/routes/tree";
import { SpacesRedirect, SpaceRedirect } from "@/routes/redirects";
import { DetailRoute } from "@/routes/detail";
import { SettingsRoute } from "@/routes/settings";
import { FilesRoute } from "@/routes/files";
import { LocalRoute } from "@/routes/local";
import { rememberPath, restoreOnBoot } from "@/lib/last-path";
import { basenameFor, stripBase } from "@/lib/base";
import { filesLoader, filesShouldRevalidate, rootLoader, paneLoader, snapshotShouldRevalidate, PANE_ROUTE_ID, ROOT_ROUTE_ID } from "@/lib/loaders";

// We don't use view transitions. React Router persists an "applied view transitions" map to
// sessionStorage ("remix-router-transitions") and replays a phantom same-location transition on every
// revalidation for any path it once saw a `viewTransition: true` navigation from. A device that ran an
// older Sightr build (which did use them) can carry a stale entry that fires
// document.startViewTransition on every poll. Clear it on boot — our code never repopulates it. The
// `:root { view-transition-name: none }` in index.css is the belt to this: even a stray transition
// then captures nothing, so there's no visible flicker regardless of this key's name.
try {
  sessionStorage.removeItem("remix-router-transitions");
} catch {
  // sessionStorage access can throw in locked-down / private contexts — ignore.
}

// Restore the last screen when the app is relaunched at the home URL.
restoreOnBoot();

// Created once at module scope so the router retains its location for the app lifetime.
export const router = createBrowserRouter([
  {
    id: ROOT_ROUTE_ID,
    path: "/",
    loader: rootLoader,
    shouldRevalidate: snapshotShouldRevalidate,
    element: <RootLayout />,
    // Catches render-phase errors and loader throws (e.g. a missing :paneId) so a component bug
    // shows a recoverable screen instead of React Router's blank default.
    errorElement: <RootError />,
    HydrateFallback: BootSplash,
    children: [
      { index: true, element: <TreeRoute /> },
      { path: "spaces", element: <SpacesRedirect /> },
      { path: "space/:spaceId", element: <SpaceRedirect /> },
      { path: "settings", element: <SettingsRoute /> },
      { path: "files", loader: filesLoader, element: <FilesRoute />, shouldRevalidate: filesShouldRevalidate },
      { path: "files/*", loader: filesLoader, element: <FilesRoute />, shouldRevalidate: filesShouldRevalidate },
      // No loader on purpose: the Local list is read only when its Scan button is tapped (lib/local-scan.ts).
      { path: "local", element: <LocalRoute /> },
      { id: PANE_ROUTE_ID, path: "pane/:paneId", loader: paneLoader, element: <DetailRoute /> },
    ],
  },
  // v1 lives at /v1/ since the T15 cutover (vite `base`); route paths stay relative to it.
], { basename: basenameFor() });

// Every settled location is remembered so a relaunch can resume it (lib/last-path).
// `state.location.pathname` carries the basename (`/v1/...`); remember the app path so a relaunch
// restores `/v1/pane/x`, not `/v1/v1/pane/x`.
router.subscribe((state) => {
  const path = stripBase(state.location.pathname);
  if (path !== null) rememberPath(path + state.location.search);
});
