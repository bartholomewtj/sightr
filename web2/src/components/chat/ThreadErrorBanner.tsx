// Adapted from T3 Code apps/web/src/components/chat/ThreadErrorBanner.tsx @ db5919d87 (MIT, see THIRD_PARTY.md).
// Changes: the error is the `error` item the latest run ended on, so the banner key is the thread plus
// that item's id; a dismissal is kept on this device (localStorage), not for the session only. The
// banner is a `ComposerBannerStackItem` row in Sightr's stack, not a floating Alert. No ChatGPT branch.
// A tooltip is hover-only, so the clamped text expands on tap instead.
import { CircleAlertIcon } from "lucide-react";
import { useState } from "react";
import { create } from "zustand";

import type { ProviderFailureClass } from "@shared/v2/contracts";
import { cn } from "~/lib/utils";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function getThreadErrorBannerKey(threadKey: string, errorItemId: string | null): string | null {
  return errorItemId === null ? null : `${threadKey}\u0000${errorItemId}`;
}

export function shouldShowThreadErrorBanner(threadKey: string, errorItemId: string | null, isDismissed: boolean): boolean {
  return getThreadErrorBannerKey(threadKey, errorItemId) !== null && !isDismissed;
}

// ── Dismissals, per device ──────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "sightr.v2.dismissedThreadErrors";
/** Only the newest dismissals are kept; an old error item never comes back as the latest anyway. */
const MAX_DISMISSED = 200;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readDismissed(): string[] {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string").slice(-MAX_DISMISSED) : [];
  } catch {
    return [];
  }
}

export const useDismissedThreadErrors = create<{ keys: string[] }>(() => ({ keys: readDismissed() }));

export function dismissThreadErrorBanner(bannerKey: string | null): void {
  if (bannerKey === null) return;
  const keys = [...useDismissedThreadErrors.getState().keys.filter((k) => k !== bannerKey), bannerKey].slice(-MAX_DISMISSED);
  useDismissedThreadErrors.setState({ keys });
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    /* private mode: the dismissal lives for this page only */
  }
}

export function isThreadErrorBannerDismissed(bannerKey: string | null, keys: readonly string[]): boolean {
  return bannerKey !== null && keys.includes(bannerKey);
}

/** Test helper: forget every dismissal (and re-read storage). */
export function __resetDismissedThreadErrors(): void {
  useDismissedThreadErrors.setState({ keys: readDismissed() }, true);
}

// ── The banner row ──────────────────────────────────────────────────────────────────────────────

/** The error text, three lines; a tap shows all of it (and a second tap folds it back). */
export function ThreadErrorText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 160 || text.split("\n").length > 3;
  if (!long) return <span className="whitespace-pre-wrap wrap-anywhere">{text}</span>;
  return (
    <button
      type="button"
      aria-expanded={open}
      data-thread-error-text=""
      className={cn("block w-full text-start whitespace-pre-wrap wrap-anywhere outline-none focus-visible:ring-2 focus-visible:ring-ring", !open && "line-clamp-3")}
      onClick={() => setOpen((v) => !v)}
    >
      {text}
    </button>
  );
}

export function threadErrorBannerItem(input: {
  readonly bannerKey: string;
  readonly title: string;
  readonly message: string;
  readonly errorClass?: ProviderFailureClass | null;
  readonly onDismiss: () => void;
}): ComposerBannerStackItem {
  return {
    id: `thread-error:${input.bannerKey}`,
    variant: input.errorClass === "usage_limit" ? "warning" : "error",
    icon: <CircleAlertIcon />,
    title: input.title,
    children: input.message.trim() ? (
      <div className="min-w-0 ps-8 pe-2 pb-1 text-muted-foreground sm:ps-7">
        <ThreadErrorText text={input.message.trim()} />
      </div>
    ) : undefined,
    dismissLabel: "Dismiss error",
    onDismiss: input.onDismiss,
  };
}
