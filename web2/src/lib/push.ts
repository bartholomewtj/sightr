// Copied from web/src/lib/push.ts (same bridge endpoints, same localStorage keys: same origin), adapted
// for web2's own service worker: subscribe through the registration at web2's scope (`/v2/` before
// cutover, `/` after T15; vite's `base`). A device that subscribed in v1 holds a different
// registration, so it gets a new endpoint here; v1's `sightr:push-endpoint` is kept, so the subscribe
// body's `replaces` names the v1 endpoint and the bridge drops that row (collie#104). One device, one
// notification per event: the last UI to subscribe owns the device's push.
//
// Left out from v1: the device store `notePushDevice` (web2 reads read-only from the shell stream).
import type { BridgeConfig } from "@shared/wire";

import { fetchConfig, XHR_HEADER, XHR_HEADER_VALUE } from "./api";

const PREF_KEY = "sightr:push-disabled";
const ONBOARDING_KEY = "sightr:push-onboarding:v1";
const DISMISS_KEY = "sightr:push-onboarding:dismissed-at";
/** How long "Not now" holds the card back. */
export const PUSH_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
/** The endpoint this device last registered with the bridge, so the next one can supersede it. */
export const ENDPOINT_KEY = "sightr:push-endpoint";

/** web2's service worker scope (vite `base`: `/v2/` until cutover) and its URL. */
export const swScope = (): string => import.meta.env.BASE_URL;
export const swUrl = (): string => `${import.meta.env.BASE_URL}sw.js`;

export type PushAvailability =
  | "unsupported" // browser lacks service worker / Push API
  | "insecure" // not a secure context (plain HTTP)
  | "server-off" // the bridge has no VAPID keys configured
  | "denied" // notifications blocked at the OS/browser level
  | "ready";

/** Why enabling push failed. "refused": the bridge said no (a device not on the allowlist). */
export type EnableFailure = Exclude<PushAvailability, "ready"> | "refused";

export interface PushState {
  availability: PushAvailability;
  /** A live subscription exists on web2's registration. */
  subscribed: boolean;
  /** The operator turned push off on this device (persisted), so nothing re-subscribes. */
  userDisabled: boolean;
}

export interface EnableResult {
  ok: boolean;
  reason?: EnableFailure;
}

export function isPushOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === "1";
  } catch {
    return false;
  }
}

export function markPushOnboarded(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, "1");
  } catch {
    /* storage blocked */
  }
}

export function dismissPushOnboarding(now = Date.now()): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(now));
  } catch {
    /* storage blocked */
  }
}

export function pushOnboardingDismissed(now = Date.now()): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (raw === null) return false;
    const stamp = Number(raw);
    return Number.isFinite(stamp) && now - stamp < PUSH_DISMISS_MS;
  } catch {
    return false;
  }
}

export function needsHomeScreenInstall(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (!ios) return false;
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true;
  return !standalone;
}

export const IOS_INSTALL_TITLE = "Install Sightr to get notifications";
export const IOS_INSTALL_NOTE =
  "iPhone and iPad only send notifications from an installed app — add Sightr to your Home Screen and open it from there.";
export const IOS_INSTALL_STEPS = ["Tap Share in Safari.", "Choose Add to Home Screen.", "Open Sightr from the new icon."] as const;

export function pushFailureText(reason: EnableFailure | undefined): string {
  switch (reason) {
    case "refused":
      return "This device isn't authorised to change notification settings.";
    case "insecure":
      return "Push needs an HTTPS connection.";
    case "server-off":
      return "Push isn't configured on the bridge (no VAPID keys).";
    case "denied":
      return "Notifications are blocked — enable them in your browser settings.";
    case "unsupported":
      return needsHomeScreenInstall() ? IOS_INSTALL_NOTE : "This browser doesn't support push notifications.";
    default:
      return "Couldn't enable push notifications.";
  }
}

/** The Settings note under the push switch when push cannot be turned on here (v1's `availabilityNote`). */
export function availabilityNote(a: PushAvailability): string {
  switch (a) {
    case "insecure":
      return "Unavailable over plain HTTP — serve Sightr over HTTPS to enable push.";
    case "server-off":
      return "The bridge has no VAPID keys configured, so push is disabled server-side.";
    case "denied":
      return "Notifications are blocked for this site. Re-enable them in your browser settings.";
    case "unsupported":
      return needsHomeScreenInstall() ? IOS_INSTALL_NOTE : "This browser doesn't support push notifications.";
    case "ready":
      return "";
  }
}

export type OnboardingCard = "enable" | "install";

export interface OnboardingInputs {
  seen: boolean;
  readOnly: boolean;
  availability: PushAvailability;
  userDisabled: boolean;
  permission: NotificationPermission;
  onboarded: boolean;
  dismissed: boolean;
  iosInstall: boolean;
}

export function pushOnboardingCard(i: OnboardingInputs): OnboardingCard | null {
  if (!i.seen || i.readOnly || i.onboarded || i.dismissed || i.userDisabled) return null;
  if (i.iosInstall && i.availability === "unsupported") return "install";
  if (i.availability === "ready" && i.permission === "default") return "enable";
  return null;
}

export function isPushDisabledByUser(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function setUserDisabled(disabled: boolean): void {
  try {
    if (disabled) localStorage.setItem(PREF_KEY, "1");
    else localStorage.removeItem(PREF_KEY);
  } catch {
    /* private mode: the preference just won't persist */
  }
}

export function rememberedEndpoint(): string | null {
  try {
    return localStorage.getItem(ENDPOINT_KEY);
  } catch {
    return null;
  }
}

function rememberEndpoint(endpoint: string | null): void {
  try {
    if (endpoint === null) localStorage.removeItem(ENDPOINT_KEY);
    else localStorage.setItem(ENDPOINT_KEY, endpoint);
  } catch {
    /* storage blocked: the next subscribe cannot supersede this one */
  }
}

/**
 * The body `/api/subscribe` receives, field by field (the bridge stores what it is sent). `replaces`
 * is present only when this device held a DIFFERENT endpoint before: a v1 endpoint the first time
 * web2 subscribes, or web2's own older one.
 */
export function subscribeBody(
  json: PushSubscriptionJSON,
  previous: string | null,
): { endpoint: string; keys: { p256dh: string; auth: string }; replaces?: string } {
  const endpoint = json.endpoint ?? "";
  const body = { endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } };
  if (previous === null || previous === "" || previous === endpoint) return body;
  return { ...body, replaces: previous };
}

export function pushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Does an existing subscription's key match the bridge's current VAPID key (a rotation strands it)? */
export function keysMatch(existing: ArrayBuffer | null | undefined, serverKey: Uint8Array): boolean {
  if (!existing) return false;
  const a = new Uint8Array(existing);
  if (a.length !== serverKey.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== serverKey[i]) return false;
  return true;
}

/**
 * web2's own registration. Before cutover v1's worker has scope `/`, which also covers `/v2/`, so
 * `getRegistration` can hand back v1's while web2's is not registered yet; that one is never ours to
 * read or unsubscribe.
 */
async function web2Registration(): Promise<ServiceWorkerRegistration | undefined> {
  const reg = await navigator.serviceWorker.getRegistration(swScope());
  if (!reg) return undefined;
  try {
    return new URL(reg.scope, window.location.href).pathname === swScope() ? reg : undefined;
  } catch {
    return undefined;
  }
}

/**
 * At boot: re-register only a subscription web2 itself holds whose endpoint the bridge no longer has
 * as this device's (v1 subscribed since, or the browser minted a new one). A device that never turned
 * push on in web2 is left alone, so opening v2 to look around does not move v1's notifications.
 */
export async function reattachPush(): Promise<{ skipped: boolean; result?: EnableResult }> {
  try {
    const reg = await web2Registration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub || sub.endpoint === rememberedEndpoint()) return { skipped: true };
  } catch {
    return { skipped: true };
  }
  return { skipped: false, result: await enablePush() };
}

/** Subscribe this device through web2's worker and register it with the bridge. */
export async function enablePush(): Promise<EnableResult> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (!window.isSecureContext) return { ok: false, reason: "insecure" };

  const reg = await navigator.serviceWorker.register(swUrl(), { scope: swScope() });
  const cfg = await fetchConfig();
  if (!cfg.push || !cfg.vapidPublicKey) return { ok: false, reason: "server-off" };
  if (Notification.permission === "denied") return { ok: false, reason: "denied" };
  if (Notification.permission !== "granted") {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, reason: "denied" };
  }

  const serverKey = urlB64ToUint8Array(cfg.vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !keysMatch(sub.options.applicationServerKey, serverKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
  const body = subscribeBody(sub.toJSON(), rememberedEndpoint());
  const res = await fetch("/api/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json", [XHR_HEADER]: XHR_HEADER_VALUE },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, reason: res.status === 403 ? "refused" : "server-off" };
  rememberEndpoint(body.endpoint);
  setUserDisabled(false);
  return { ok: true };
}

/**
 * Unsubscribe web2's registration and remember the choice. The bridge drops the endpoint on its next
 * send (410). v1's registration, if any, is not touched: its row was already replaced when web2
 * subscribed.
 */
export async function disablePush(): Promise<void> {
  setUserDisabled(true);
  if (!pushSupported()) return;
  try {
    const reg = await web2Registration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
    rememberEndpoint(null);
  } catch {
    /* best effort: the stored preference still stops a re-subscribe */
  }
}

/** The push state for Settings. */
export async function getPushState(): Promise<PushState> {
  const userDisabled = isPushDisabledByUser();
  if (!pushSupported()) return { availability: "unsupported", subscribed: false, userDisabled };
  if (!window.isSecureContext) return { availability: "insecure", subscribed: false, userDisabled };

  let subscribed = false;
  try {
    const reg = await web2Registration();
    subscribed = Boolean(await reg?.pushManager.getSubscription());
  } catch {
    /* treat as not subscribed */
  }

  if (Notification.permission === "denied") return { availability: "denied", subscribed, userDisabled };

  let cfg: BridgeConfig;
  try {
    cfg = await fetchConfig();
  } catch {
    cfg = { push: false, vapidPublicKey: "" };
  }
  if (!cfg.push || !cfg.vapidPublicKey) return { availability: "server-off", subscribed, userDisabled };
  return { availability: "ready", subscribed, userDisabled };
}
