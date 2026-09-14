import { fetchConfig, XHR_HEADER, XHR_HEADER_VALUE } from "@/lib/api";
import { isReadOnly, type BridgeConfig, type DeviceAuth } from "@/lib/types";

// Client-side control of Web Push: the browser subscription plus a per-device preference. We persist
// the user's choice so we don't re-subscribe on next load.
//
// ── WHY THIS DEVICE HAS TO NAME ITS OWN PREDECESSOR ──────────────────────────
// An explicit `unsubscribe()` does make the endpoint 410 on the next send, and the bridge drops it
// then (there is no unsubscribe endpoint to call). But that covers only the endpoints we retire on
// purpose. A service worker re-registration — a home-screen reinstall, a rejected push topic, a
// re-subscribe after the bridge restarts — mints a BRAND-NEW endpoint and abandons the old one
// without unsubscribing it, and the push service happily keeps accepting sends to that orphan
// forever. Nothing server-side can tell it apart from a live device, so twenty of them piled up in
// one single-user install (collie#104). This device is the only party that knows the new endpoint
// and the old one are the same phone, so it says so: `replaces` on the subscribe body, remembered
// here across reloads.

const PREF_KEY = "sightr:push-disabled";
const ONBOARDING_KEY = "sightr:push-onboarding:v1";
const DISMISS_KEY = "sightr:push-onboarding:dismissed-at";
/** How long "Not now" holds the card back. */
export const PUSH_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
/** The endpoint this device last registered with the bridge, so the next one can supersede it. */
const ENDPOINT_KEY = "sightr:push-endpoint";

export type PushAvailability =
  | "unsupported" // browser lacks service worker / Push API
  | "insecure" // not a secure context (plain HTTP) — Push can't run
  | "server-off" // the bridge has no VAPID keys configured
  | "denied" // notifications blocked at the OS/browser level
  | "ready"; // available to toggle

/** Why enabling push failed. "refused" is the bridge saying no — a device that isn't allow-listed
 *  can't register for the operator's push stream (issue #8). */
type EnableFailure = Exclude<PushAvailability, "ready"> | "refused";

export interface PushState {
  availability: PushAvailability;
  /** A live PushManager subscription currently exists on this device. */
  subscribed: boolean;
  /** The user turned push off here (persisted), so we don't auto-resubscribe. */
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
  try { localStorage.setItem(DISMISS_KEY, String(now)); } catch { /* storage blocked */ }
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
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true;
  return !standalone;
}

export const IOS_INSTALL_TITLE = "Install Sightr to get notifications";
export const IOS_INSTALL_NOTE = "iPhone and iPad only send notifications from an installed app — add Sightr to your Home Screen and open it from there.";
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

let deviceState = { seen: false, readOnly: false };
const deviceListeners = new Set<() => void>();

export function notePushDevice(device: DeviceAuth | undefined): void {
  const next = { seen: true, readOnly: isReadOnly(device) };
  if (deviceState.seen === next.seen && deviceState.readOnly === next.readOnly) return;
  deviceState = next;
  for (const listener of deviceListeners) listener();
}

export function getPushDevice(): { seen: boolean; readOnly: boolean } {
  return deviceState;
}

export function subscribePushDevice(listener: () => void): () => void {
  deviceListeners.add(listener);
  return () => deviceListeners.delete(listener);
}

export function resetPushDevice(): void {
  deviceState = { seen: false, readOnly: false };
  deviceListeners.clear();
}

type OnboardingCard = "enable" | "install";

interface OnboardingInputs {
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

/** @deprecated Use pushOnboardingCard for the card mode. */


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
    /* private mode / storage blocked — the preference just won't persist */
  }
}

function rememberedEndpoint(): string | null {
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
    /* private mode / storage blocked — we just can't supersede next time */
  }
}

/** The body `/api/subscribe` receives, built field by field rather than by serialising the
 *  PushSubscription whole: the bridge stores what it is sent, so the shape is a contract. `replaces`
 *  is present only when this device held a DIFFERENT endpoint before — re-registering the same one
 *  supersedes nothing. Pure, and exported, because `enablePush` itself needs a real PushManager. */
export function subscribeBody(
  json: PushSubscriptionJSON,
  previous: string | null,
): { endpoint: string; keys: { p256dh: string; auth: string }; replaces?: string } {
  const endpoint = json.endpoint ?? "";
  const body = {
    endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
  };
  if (previous === null || previous === "" || previous === endpoint) return body;
  return { ...body, replaces: previous };
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Does an existing subscription's applicationServerKey match the server's current VAPID key? A
// subscription is permanently bound to the key it was created with, so when the bridge rotates its
// VAPID keypair every push to the old subscription silently fails — we must detect the mismatch and
// re-subscribe. `existing` is the raw ArrayBuffer from `subscription.options.applicationServerKey`.
export function keysMatch(existing: ArrayBuffer | null | undefined, serverKey: Uint8Array): boolean {
  if (!existing) return false;
  const a = new Uint8Array(existing);
  if (a.length !== serverKey.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== serverKey[i]) return false;
  return true;
}

// Subscribe this device to push and register it with the bridge; clears the user's "disabled"
// preference on success. Returns whether a live subscription now exists (with a reason if not).
/** Re-attach push at boot only when this device has a different or unknown endpoint. */
export async function reattachPush(): Promise<{ skipped: boolean; result?: EnableResult }> {
  const known = rememberedEndpoint();
  if (known) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub?.endpoint === known) return { skipped: true };
    } catch {
      /* fall through to the full enable path */
    }
  }
  return { skipped: false, result: await enablePush() };
}

export async function enablePush(): Promise<EnableResult> {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  if (!window.isSecureContext) return { ok: false, reason: "insecure" };

  const reg = await navigator.serviceWorker.register("/sw.js");
  const cfg = await fetchConfig();
  if (!cfg.push || !cfg.vapidPublicKey) return { ok: false, reason: "server-off" };
  if (Notification.permission === "denied") return { ok: false, reason: "denied" };
  if (Notification.permission !== "granted") {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, reason: "denied" };
  }

  const serverKey = urlB64ToUint8Array(cfg.vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  // A stale subscription bound to a rotated (or otherwise different) VAPID key would keep receiving
  // nothing — drop it and re-subscribe fresh against the current key.
  if (sub && !keysMatch(sub.options.applicationServerKey, serverKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: serverKey,
    });
  }
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

// Unsubscribe this device and remember the choice. This is the case the server-side prune DOES
// cover: an explicitly unsubscribed endpoint 410s on the next send and the bridge drops it, so
// there's nothing to call server-side. We forget it here too — the row it leaves behind is already
// doomed, and a later re-subscribe must not claim to supersede an endpoint it has no relation to.
export async function disablePush(): Promise<void> {
  setUserDisabled(true);
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
    rememberEndpoint(null);
  } catch {
    /* best-effort: the persisted preference still prevents re-subscription */
  }
}

// Snapshot the current push state for the settings UI.
export async function getPushState(): Promise<PushState> {
  const userDisabled = isPushDisabledByUser();
  if (!pushSupported()) return { availability: "unsupported", subscribed: false, userDisabled };
  if (!window.isSecureContext) return { availability: "insecure", subscribed: false, userDisabled };

  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    subscribed = Boolean(await reg?.pushManager.getSubscription());
  } catch {
    /* ignore — treat as not subscribed */
  }

  if (Notification.permission === "denied") {
    return { availability: "denied", subscribed, userDisabled };
  }

  let cfg: BridgeConfig;
  try {
    cfg = await fetchConfig();
  } catch {
    cfg = { push: false, vapidPublicKey: "" };
  }
  if (!cfg.push || !cfg.vapidPublicKey) {
    return { availability: "server-off", subscribed, userDisabled };
  }

  return { availability: "ready", subscribed, userDisabled };
}
