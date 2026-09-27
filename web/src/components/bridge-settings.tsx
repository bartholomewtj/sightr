import { useEffect, useState } from "react";
import { Server } from "lucide-react";
import { Card } from "@/components/ui/card";
import { getBridgeSettings, setBridgeSettings, ApiError } from "@/lib/api";
import type { BridgeSettingKey, BridgeSettings, BridgeSettingsView, DeviceAuth } from "@/lib/types";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";

// Bridge-wide runtime settings. Each value can come from the host's `.env` or from a save here
// (stateDir/settings.json overlays `.env`). Every row says which, and an overridden row has
// "Use .env" to drop the override — before, a value saved months ago silently beat `.env` forever.
// Notify delay is edited in seconds; the wire and `.env` stay in milliseconds.

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const seconds = (ms: number) => String(Math.round(ms / 100) / 10);
const seed = (s: BridgeSettings) => ({ allow: s.deviceAllowlist.join(", "), delay: seconds(s.notifyDelayMs), keys: s.submitKeys.join(", "), lines: String(s.readLines) });
type DraftKey = "allow" | "delay" | "keys" | "lines";
const ROWS: ReadonlyArray<readonly [label: string, key: DraftKey, setting: BridgeSettingKey, type: "text" | "number", hint: string]> = [
  ["Device allowlist", "allow", "deviceAllowlist", "text", "Device ids allowed to type into agents. Empty with the device header set = every device is read-only."],
  ["Notify delay (seconds)", "delay", "notifyDelayMs", "number", "How long a pane must stay blocked before it raises a push notification."],
  ["Submit keys", "keys", "submitKeys", "text", "Keys sent to submit a reply after the text. Agent-dependent."],
  ["Read lines", "lines", "readLines", "number", "Scrollback lines pulled for the pane view."],
];
const SHOWN: Record<BridgeSettingKey, (s: BridgeSettings) => string> = {
  deviceAllowlist: (s) => s.deviceAllowlist.join(", ") || "empty",
  notifyDelayMs: (s) => `${seconds(s.notifyDelayMs)} s`,
  submitKeys: (s) => s.submitKeys.join(", "),
  readLines: (s) => String(s.readLines),
};

export function BridgeSettings({ readOnly = false, device }: { readOnly?: boolean; device?: DeviceAuth }) {
  const [settings, setSettings] = useState<BridgeSettingsView | null>(null);
  const [draft, setDraft] = useState({ allow: "", delay: "", keys: "", lines: "" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const { confirm } = usePendingConfirm();
  useEffect(() => { let alive = true; getBridgeSettings().then((s) => { if (alive) { setSettings(s); setDraft(seed(s)); } }).catch(() => {}); return () => { alive = false; }; }, []);
  async function send(patch: Parameters<typeof setBridgeSettings>[0]) {
    if (!settings) return;
    setBusy(true); try { const next = await setBridgeSettings(patch); setSettings(next); setDraft(seed(next)); } catch (e) { setError(e instanceof ApiError ? (e.status === 403 ? "Read-only — this device isn't authorised to change bridge settings." : e.message) : "Could not save bridge settings."); setDraft(seed(settings)); } finally { setBusy(false); }
  }
  async function save() {
    if (!settings) return; setError(null);
    const patch: Partial<BridgeSettings> = {};
    const allow = list(draft.allow), keys = list(draft.keys);
    const delayMs = Math.round(Number(draft.delay) * 1000);
    if (allow.join("\0") !== settings.deviceAllowlist.join("\0")) patch.deviceAllowlist = allow;
    if (delayMs !== settings.notifyDelayMs) patch.notifyDelayMs = delayMs;
    if (keys.join("\0") !== settings.submitKeys.join("\0")) patch.submitKeys = keys;
    if (Number(draft.lines) !== settings.readLines) patch.readLines = Number(draft.lines);
    if (!Object.keys(patch).length) return;
    if (device?.enforced && device.device && patch.deviceAllowlist && !patch.deviceAllowlist.includes(device.device) && !confirm("revoke-self")) return setError("This removes this phone's access.");
    await send(patch);
  }
  const disabled = readOnly || busy || !settings;
  // An older bridge sends no `overridden`/`defaults`; then the source line is simply left out.
  const known = Boolean(settings?.overridden && settings.defaults);
  return <Card className="gap-0 py-0">
    <div className="flex items-center gap-3 p-4"><Server className="size-5 text-muted-foreground" /><div><div className="font-medium">Bridge</div><p className="text-sm text-muted-foreground">Runtime settings shared by all devices.</p></div></div>
    {ROWS.map(([label, key, setting, type, hint]) => {
      const overridden = known && settings!.overridden!.includes(setting);
      return <div key={key} className="border-t border-border/60 px-4 py-3">
        <label className="block">
          <div className="text-sm font-medium">{label}</div>
          <p className="text-xs text-muted-foreground">{hint}{key === "allow" && !device?.enforced ? " Per-device auth is off on this bridge, so this list has no effect yet." : ""}</p>
          <input aria-label={label} type={type} step={key === "delay" ? "any" : undefined} value={draft[key]} disabled={disabled} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} className="mt-2 w-full rounded-md border border-input bg-background px-2 py-1" />
        </label>
        {known && <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span data-testid={`source-${setting}`}>{overridden ? `Set here · .env is ${SHOWN[setting](settings!.defaults!)}` : "From .env"}</span>
          {overridden && <button type="button" disabled={disabled} onClick={() => { setError(null); void send({ reset: [setting] }); }} className="rounded px-1.5 py-0.5 font-medium text-foreground underline underline-offset-2 disabled:opacity-50">Use .env</button>}
        </div>}
      </div>;
    })}
    <div className="flex items-center gap-3 border-t border-border/60 p-4"><button type="button" disabled={disabled} onClick={() => void save()} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground">Save</button>{error && <span className="text-xs text-status-blocked">{error}</span>}</div>
  </Card>;
}
