// Copied from web/src/components/connection-info.tsx, on web2's stores: where this client is connected,
// whether it is a secure context (push and the lock need one), the herdr link, this device's access,
// and two build ids: the bundle running here (`__BUILD_INFO__`) and the web2 bundle the bridge serves
// now (its `x-sightr-build` header, lib/server-build.ts). Different ids mean a newer web2 is waiting
// for the service worker to swap it in. Read-only diagnostics.
import type { ReactNode } from "react";

import type { HerdrLink, V2DeviceAuth } from "@shared/v2/contracts";
import { useServerBuild } from "@/lib/server-build";
import { useBridgeInfo, useStreamHealth } from "@/stream/stores";
import { SettingsRow } from "./settingsLayout";

export function ConnectionInfo() {
  const herdr = useBridgeInfo((s) => s.herdr);
  const device = useBridgeInfo((s) => s.device);
  const stream = useStreamHealth((s) => s.status);
  const serverBuild = useServerBuild();
  const b = bridgeLabel(stream, herdr);
  const d = deviceLabel(device);
  const secure = typeof window !== "undefined" && window.isSecureContext;
  const host = typeof window !== "undefined" ? window.location.host : "—";

  return (
    <SettingsRow title="Connection" description="Diagnostics for this device.">
      <dl className="mt-2 divide-y divide-border/50 rounded-lg border border-border/50">
        <Row label="Endpoint">{host}</Row>
        <Row label="Secure context">{secure ? "Yes" : "No (plain HTTP)"}</Row>
        <Row label="Bridge">
          <span className={b.tone}>{b.text}</span>
        </Row>
        <Row label="Device access">
          <span className={d.tone}>{d.text}</span>
        </Row>
        <Row label="This build">{__BUILD_INFO__.id}</Row>
        {/* Always present: an em dash is a truthful "not known yet", and the card keeps its height. */}
        <Row label="Server build">{serverBuild ?? "—"}</Row>
      </dl>
    </SettingsRow>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-mono text-[13px]">{children}</dd>
    </div>
  );
}

function bridgeLabel(stream: string, herdr: HerdrLink | null): { text: string; tone: string } {
  if (stream === "lost") return { text: "Not connected", tone: "text-warning" };
  if (herdr === "connected") return { text: "Connected", tone: "text-success" };
  if (herdr === "disconnected") return { text: "Herdr offline", tone: "text-warning" };
  return { text: "Connecting…", tone: "text-muted-foreground" };
}

// Mirrors the bridge's device-auth matrix. "Local" = an authorised request with no device header.
function deviceLabel(device: V2DeviceAuth | null): { text: string; tone: string } {
  if (!device || !device.enforced) return { text: "Not enforced", tone: "text-muted-foreground" };
  if (device.authorized) {
    return { text: device.device ? `Full access · ${device.device}` : "Full access (local)", tone: "text-success" };
  }
  return { text: device.device ? `Read-only · ${device.device}` : "Read-only", tone: "text-warning" };
}
