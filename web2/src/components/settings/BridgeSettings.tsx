// Copied from web/src/components/bridge-settings.tsx (same `/api/settings` route), as settings rows.
// Bridge-wide runtime settings: each value comes from the host's `.env` or from a save here
// (stateDir/settings.json overlays `.env`); every row says which, and an overridden row has "Use .env".
// Notify delay is edited in seconds; the wire and `.env` stay in milliseconds. Read-only devices see
// the values but cannot save.
import { useEffect, useState } from "react";

import type { BridgeSettingKey, BridgeSettings as BridgeSettingsValues, BridgeSettingsView } from "@shared/wire";
import type { V2DeviceAuth } from "@shared/v2/contracts";
import { Button } from "~/components/ui/button";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { ApiError, getBridgeSettings, setBridgeSettings } from "@/lib/api";
import { SettingsRow } from "./settingsLayout";

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const seconds = (ms: number) => String(Math.round(ms / 100) / 10);
const seed = (s: BridgeSettingsValues) => ({
  allow: s.deviceAllowlist.join(", "),
  delay: seconds(s.notifyDelayMs),
  keys: s.submitKeys.join(", "),
  lines: String(s.readLines),
  settle: String(s.autoSettleDays ?? 0),
});
type DraftKey = "allow" | "delay" | "keys" | "lines" | "settle";
const ROWS: ReadonlyArray<readonly [label: string, key: DraftKey, setting: BridgeSettingKey, type: "text" | "number", hint: string]> = [
  ["Device allowlist", "allow", "deviceAllowlist", "text", "Device ids allowed to type into agents. Empty with the device header set = every device is read-only."],
  ["Notify delay (seconds)", "delay", "notifyDelayMs", "number", "How long a pane must stay blocked before it raises a push notification."],
  ["Submit keys", "keys", "submitKeys", "text", "Keys sent to submit a reply after the text. Agent-dependent."],
  ["Read lines", "lines", "readLines", "number", "Lines read when a request names no count, and the least read to check a prompt before sending."],
  ["Auto-settle (days)", "settle", "autoSettleDays", "number", "Settle an active thread after this many days with no activity. 0 is off. Pinned, working and waiting threads are never settled."],
];
const SHOWN: Record<BridgeSettingKey, (s: BridgeSettingsValues) => string> = {
  deviceAllowlist: (s) => s.deviceAllowlist.join(", ") || "empty",
  notifyDelayMs: (s) => `${seconds(s.notifyDelayMs)} s`,
  submitKeys: (s) => s.submitKeys.join(", "),
  readLines: (s) => String(s.readLines),
  autoSettleDays: (s) => (s.autoSettleDays ? `${s.autoSettleDays} days` : "off"),
};

export function BridgeSettings({ readOnly = false, device }: { readOnly?: boolean; device?: V2DeviceAuth | null }) {
  const [settings, setSettings] = useState<BridgeSettingsView | null>(null);
  const [draft, setDraft] = useState({ allow: "", delay: "", keys: "", lines: "", settle: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { confirm } = usePendingConfirm();

  useEffect(() => {
    let alive = true;
    getBridgeSettings()
      .then((s) => {
        if (!alive) return;
        setSettings(s);
        setDraft(seed(s));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function send(patch: Parameters<typeof setBridgeSettings>[0]) {
    if (!settings) return;
    setBusy(true);
    try {
      const next = await setBridgeSettings(patch);
      setSettings(next);
      setDraft(seed(next));
      setSaved(true);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 403
          ? "Read-only — this device isn't authorised to change bridge settings."
          : e instanceof ApiError && e.detail
            ? `Could not save bridge settings: ${e.detail}.`
            : "Could not save bridge settings.",
      );
      setDraft(seed(settings));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!settings) return;
    setError(null);
    setSaved(false);
    const patch: Partial<BridgeSettingsValues> = {};
    const allow = list(draft.allow);
    const keys = list(draft.keys);
    const delayMs = Math.round(Number(draft.delay) * 1000);
    if (allow.join("\0") !== settings.deviceAllowlist.join("\0")) patch.deviceAllowlist = allow;
    if (delayMs !== settings.notifyDelayMs) patch.notifyDelayMs = delayMs;
    if (keys.join("\0") !== settings.submitKeys.join("\0")) patch.submitKeys = keys;
    if (Number(draft.lines) !== settings.readLines) patch.readLines = Number(draft.lines);
    if (settings.autoSettleDays !== undefined && Number(draft.settle) !== settings.autoSettleDays) patch.autoSettleDays = Number(draft.settle);
    if (Object.keys(patch).length === 0) return;
    if (
      device?.enforced &&
      device.device &&
      patch.deviceAllowlist &&
      !patch.deviceAllowlist.includes(device.device) &&
      !confirm("revoke-self")
    ) {
      setError("This removes this device's access. Save again to confirm.");
      return;
    }
    await send(patch);
  }

  const disabled = readOnly || busy || !settings;
  // An older bridge sends no `overridden`/`defaults`; then the source line is left out.
  const known = Boolean(settings?.overridden && settings.defaults);

  return (
    <>
      {ROWS.map(([label, key, setting, type, hint]) => {
        // An older bridge has no auto-settle.
        if (setting === "autoSettleDays" && settings && settings.autoSettleDays === undefined) return null;
        const overridden = known && settings!.overridden!.includes(setting);
        const inputId = `bridge-setting-${key}`;
        return (
          <SettingsRow
            key={key}
            title={<label htmlFor={inputId}>{label}</label>}
            description={`${hint}${key === "allow" && !device?.enforced ? " Per-device auth is off on this bridge, so this list has no effect yet." : ""}`}
            disabled={readOnly}
            status={
              known ? (
                <span className="flex items-center gap-2">
                  <span data-testid={`source-${setting}`}>
                    {overridden ? `Set here · .env is ${SHOWN[setting](settings!.defaults!)}` : "From .env"}
                  </span>
                  {overridden ? (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setError(null);
                        void send({ reset: [setting] });
                      }}
                      className="rounded px-1.5 py-0.5 font-medium text-foreground underline underline-offset-2 disabled:opacity-50 pointer-coarse:min-h-11"
                    >
                      Use .env
                    </button>
                  ) : null}
                </span>
              ) : null
            }
            control={
              <input
                id={inputId}
                aria-label={label}
                type={type}
                step={key === "delay" ? "any" : undefined}
                value={draft[key]}
                disabled={disabled}
                onChange={(e) => {
                  setSaved(false);
                  setDraft({ ...draft, [key]: e.target.value });
                }}
                className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-base text-foreground sm:text-sm pointer-coarse:h-11 outline-none focus:border-ring disabled:opacity-64 @min-[32rem]/settings-row:w-56"
              />
            }
          />
        );
      })}
      <SettingsRow
        title="Save bridge settings"
        description="Applies to every device at once."
        status={
          error ? (
            <span role="alert" className="text-destructive">
              {error}
            </span>
          ) : saved ? (
            <span role="status">Saved.</span>
          ) : null
        }
        control={
          <Button size="sm" disabled={disabled} onClick={() => void save()}>
            Save
          </Button>
        }
      />
    </>
  );
}
