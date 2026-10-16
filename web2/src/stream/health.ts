// The banner thresholds, shared with v1 (web/src/lib/connection-health.ts) so both apps escalate alike:
// amber "Reconnecting…" after TROUBLE_MS not live, red "Not connected" after CONNECTION_LOST_MS.
export { CONNECTION_LOST_MS, TROUBLE_MS } from "@v1/lib/connection-health";
