import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./index.css";
// Registers the service worker (precaches the app shell, enables install) and wires auto/manual
// updates. Guards on `serviceWorker in navigator`, so over plain HTTP (insecure context) it no-ops.
import "./lib/pwa";
import { startConnTelemetry } from "./lib/conn-telemetry";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Connection telemetry for `sightr-ctl conn` (timings only; see lib/conn-telemetry.ts).
startConnTelemetry();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
