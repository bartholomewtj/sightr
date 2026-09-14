import { useEffect, useState } from "react";
import { Server } from "lucide-react";
import { Card } from "@/components/ui/card";
import { getBridgeSettings, setBridgeSettings, ApiError } from "@/lib/api";
import type { BridgeSettings, DeviceAuth } from "@/lib/types";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const seed = (s: BridgeSettings) => ({ allow: s.deviceAllowlist.join(", "), delay: String(s.notifyDelayMs), keys: s.submitKeys.join(", "), lines: String(s.readLines) });
export function BridgeSettings({ readOnly = false, device }: { readOnly?: boolean; device?: DeviceAuth }) {
  const [settings, setSettings] = useState<BridgeSettings | null>(null);
  const [draft, setDraft] = useState({ allow: "", delay: "", keys: "", lines: "" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const { confirm } = usePendingConfirm();
  useEffect(() => { let alive = true; getBridgeSettings().then((s) => { if (alive) { setSettings(s); setDraft(seed(s)); } }).catch(() => {}); return () => { alive = false; }; }, []);
  async function save() {
    if (!settings) return; setError(null);
    const patch: Partial<BridgeSettings> = {};
    const allow = list(draft.allow), keys = list(draft.keys);
    if (allow.join("\0") !== settings.deviceAllowlist.join("\0")) patch.deviceAllowlist = allow;
    if (Number(draft.delay) !== settings.notifyDelayMs) patch.notifyDelayMs = Number(draft.delay);
    if (keys.join("\0") !== settings.submitKeys.join("\0")) patch.submitKeys = keys;
    if (Number(draft.lines) !== settings.readLines) patch.readLines = Number(draft.lines);
    if (!Object.keys(patch).length) return;
    if (device?.enforced && device.device && patch.deviceAllowlist && !patch.deviceAllowlist.includes(device.device) && !confirm("revoke-self")) return setError("This removes this phone's access.");
    setBusy(true); try { const next = await setBridgeSettings(patch); setSettings(next); setDraft(seed(next)); } catch (e) { setError(e instanceof ApiError ? (e.status === 403 ? "Read-only — this device isn't authorised to change bridge settings." : e.message) : "Could not save bridge settings."); setDraft(seed(settings)); } finally { setBusy(false); }
  }
  const disabled = readOnly || busy || !settings;
  const rows = [
    ["Device allowlist", "allow", "text", "Device ids allowed to type into agents. Empty with the device header set = every device is read-only."],
    ["Notify delay", "delay", "number", "How long a pane must stay blocked before it raises a push notification."],
    ["Submit keys", "keys", "text", "Keys sent to submit a reply after the text. Agent-dependent."],
    ["Read lines", "lines", "number", "Scrollback lines pulled for the pane view."],
  ] as const;
  return <Card className="gap-0 py-0"><div className="flex items-center gap-3 p-4"><Server className="size-5 text-muted-foreground" /><div><div className="font-medium">Bridge</div><p className="text-sm text-muted-foreground">Runtime settings shared by all devices.</p></div></div>{rows.map(([label, key, type, hint]) => <label key={key} className="block border-t border-border/60 px-4 py-3"><div className="text-sm font-medium">{label}</div><p className="text-xs text-muted-foreground">{hint}{key === "allow" && !device?.enforced ? " Per-device auth is off on this bridge, so this list has no effect yet." : ""}</p><input aria-label={label} type={type} value={draft[key]} disabled={disabled} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} className="mt-2 w-full rounded-md border border-input bg-background px-2 py-1" /></label>)}<div className="flex items-center gap-3 border-t border-border/60 p-4"><button type="button" disabled={disabled} onClick={() => void save()} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground">Save</button>{error && <span className="text-xs text-status-blocked">{error}</span>}</div></Card>;
}
