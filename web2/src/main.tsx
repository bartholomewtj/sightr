import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { startConnTelemetry } from "@v1/lib/conn-telemetry";

import "./index.css";
// The theme class and theme-color meta (Settings → Appearance); theme-init.js did the first paint.
import "./hooks/use-theme";
// Registers the service worker at `/sw.js` (precache, install, push, updates). No-op over plain HTTP.
import "./lib/pwa";
import { getRouter } from "./router";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Connection telemetry for `sightr-ctl conn`, the same recorder as v1 (timings only).
startConnTelemetry();

const router = getRouter();

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
