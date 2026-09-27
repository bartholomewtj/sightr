import { writeJsonAtomic, readJsonOr } from "./json-file.ts";
import { join } from "node:path";
import { SILENT_AUDIT, type AuditDetail, type AuditLog } from "./audit.ts";
import type { Config } from "./config.ts";
import { normalizeChord } from "./operator-keys.ts";
import { json, requireJsonBody, text } from "./responses.ts";

export interface RuntimeSettings { deviceAllowlist: string[]; notifyDelayMs: number; submitKeys: string[]; readLines: number; }
export type RuntimeSettingKey = keyof RuntimeSettings;
const SETTING_KEYS: readonly RuntimeSettingKey[] = ["deviceAllowlist", "notifyDelayMs", "submitKeys", "readLines"];
/** What GET/POST /api/settings return: the effective values, which of them the Settings page has
 *  overridden, and the `.env` values underneath — so the page can say where each value comes from. */
export interface RuntimeSettingsView extends RuntimeSettings { overridden: RuntimeSettingKey[]; defaults: RuntimeSettings; }
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function defaultsFrom(cfg: Config): RuntimeSettings { return { deviceAllowlist: [...cfg.deviceAllowlist], notifyDelayMs: cfg.notifyDelayMs, submitKeys: [...cfg.submitKeys], readLines: cfg.readLines }; }
export function coerceStored(raw: unknown): Partial<RuntimeSettings> {
  const o = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out: Partial<RuntimeSettings> = {};
  if (Array.isArray(o.deviceAllowlist) && o.deviceAllowlist.every((x) => typeof x === "string")) out.deviceAllowlist = [...o.deviceAllowlist] as string[];
  if (typeof o.notifyDelayMs === "number" && Number.isFinite(o.notifyDelayMs)) out.notifyDelayMs = o.notifyDelayMs;
  if (Array.isArray(o.submitKeys) && o.submitKeys.every((x) => typeof x === "string")) out.submitKeys = [...o.submitKeys] as string[];
  if (typeof o.readLines === "number" && Number.isFinite(o.readLines)) out.readLines = o.readLines;
  return out;
}
let active: RuntimeSettingsStore | null = null;
export function effectiveSettings(cfg: Config): RuntimeSettings { return active ? active.current() : defaultsFrom(cfg); }
export function resetRuntimeSettings(): void { active = null; }
export class RuntimeSettingsStore {
  private overlayObj: Partial<RuntimeSettings> = {};
  private readonly file: string;
  constructor(private readonly cfg: Config) { this.file = join(cfg.stateDir, "settings.json"); active = this; }
  async load(): Promise<void> { try { this.overlayObj = coerceStored(await readJsonOr(this.file, null)); } catch { this.overlayObj = {}; } }
  current(): RuntimeSettings { const x = this.overlayObj; return { deviceAllowlist: [...(x.deviceAllowlist ?? this.cfg.deviceAllowlist)], notifyDelayMs: x.notifyDelayMs ?? this.cfg.notifyDelayMs, submitKeys: [...(x.submitKeys ?? this.cfg.submitKeys)], readLines: x.readLines ?? this.cfg.readLines }; }
  overlay(): Partial<RuntimeSettings> { return { ...this.overlayObj, ...(this.overlayObj.deviceAllowlist ? { deviceAllowlist: [...this.overlayObj.deviceAllowlist] } : {}), ...(this.overlayObj.submitKeys ? { submitKeys: [...this.overlayObj.submitKeys] } : {}) }; }
  /** Apply a patch. A value equal to the `.env` default drops its override, so the source reads `.env` again. */
  async set(patch: Partial<RuntimeSettings>, reset: readonly RuntimeSettingKey[] = []): Promise<RuntimeSettings> {
    const defaults = defaultsFrom(this.cfg);
    const next: Record<string, unknown> = { ...this.overlayObj, ...patch };
    for (const k of SETTING_KEYS) if (reset.includes(k) || (k in next && sameValue(next[k], defaults[k]))) delete next[k];
    this.overlayObj = next as Partial<RuntimeSettings>;
    await this.save();
    return this.current();
  }
  view(): RuntimeSettingsView { return { ...this.current(), overridden: SETTING_KEYS.filter((k) => k in this.overlayObj), defaults: defaultsFrom(this.cfg) }; }
  private async save(): Promise<void> { await writeJsonAtomic(this.file, this.overlayObj, { indent: 2 }); }
}
export type PatchResult = { ok: true; patch: Partial<RuntimeSettings>; reset: RuntimeSettingKey[] } | { ok: false; error: string };
export function validateSettingsPatch(body: unknown): PatchResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "bad request" };
  const input = body as Record<string, unknown>; const allowed = new Set(["deviceAllowlist", "notifyDelayMs", "submitKeys", "readLines", "reset"]);
  for (const k of Object.keys(input)) if (!allowed.has(k)) return { ok: false, error: `unknown setting: ${k}` };
  const patch: Partial<RuntimeSettings> = {};
  const reset: RuntimeSettingKey[] = [];
  if ("reset" in input) { const v = input.reset; if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !(SETTING_KEYS as readonly string[]).includes(x))) return { ok: false, error: "bad reset" }; reset.push(...(v as RuntimeSettingKey[])); }
  if ("deviceAllowlist" in input) { const v = input.deviceAllowlist; if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { ok: false, error: "bad deviceAllowlist" }; const vals = [...new Set((v as string[]).map((x) => x.trim()))]; if (vals.some((x) => !x || x.length > 64) || vals.length > 64) return { ok: false, error: "bad deviceAllowlist" }; patch.deviceAllowlist = vals; }
  if ("notifyDelayMs" in input) { const v = input.notifyDelayMs; if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 600000) return { ok: false, error: "bad notifyDelayMs" }; patch.notifyDelayMs = v; }
  if ("readLines" in input) { const v = input.readLines; if (typeof v !== "number" || !Number.isInteger(v) || v < 50 || v > 10000) return { ok: false, error: "bad readLines" }; patch.readLines = v; }
  if ("submitKeys" in input) { const v = input.submitKeys; if (!Array.isArray(v) || v.length < 1 || v.length > 8 || v.some((x) => typeof x !== "string")) return { ok: false, error: "bad submitKeys" }; const keys = (v as string[]).map(normalizeChord); if (keys.some((x) => x === null)) return { ok: false, error: "bad submitKeys" }; patch.submitKeys = keys as string[]; }
  return { ok: true, patch, reset };
}
export async function settingsRoute(
  req: Request,
  _cfg: Config,
  store: RuntimeSettingsStore,
  audit: AuditLog = SILENT_AUDIT,
): Promise<Response> {
  if (req.method === "GET") return json(store.view(), req.headers.get("accept-encoding"));
  if (req.method !== "POST") return text("method not allowed", 405);
  const bad = requireJsonBody(req); if (bad) return bad;
  let body: unknown; try { body = await req.json(); } catch { return text("bad request", 400); }
  const result = validateSettingsPatch(body); if (!result.ok) return text(result.error, 400);
  await store.set(result.patch, result.reset);
  audit.record({
    action: "settings",
    detail: { keys: Object.keys(result.patch), settings: result.patch as AuditDetail, ...(result.reset.length ? { reset: result.reset } : {}) },
  });
  return json(store.view(), req.headers.get("accept-encoding"));
}
