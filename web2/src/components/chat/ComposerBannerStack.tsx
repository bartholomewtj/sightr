// Adapted from T3 Code apps/web/src/components/chat/ComposerBannerStack.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: every notice is its own row, worst first (T3's `bannerPriority`, then newest first); no
// collapsed peek, hover expansion or exit animation, which a phone cannot hover anyway. The item shape
// (`ComposerBannerStackItem`) and the alert row are T3's.
import type { ReactNode } from "react";

import { ComposerBanner, type ComposerBannerVariant } from "./ComposerBanner";

export interface ComposerBannerStackItem {
  readonly id: string;
  readonly variant: ComposerBannerVariant;
  readonly priority?: "urgent" | "activity" | "notice";
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly dismissLabel?: string;
  /** Only where the condition can clear itself does the row get a dismiss button. */
  readonly onDismiss?: () => void;
}

export function bannerPriority(item: Pick<ComposerBannerStackItem, "priority" | "variant">): number {
  if (item.priority === "activity") return 0;
  if (item.priority === "urgent" || item.variant === "error" || item.variant === "warning") return 1;
  return 2;
}

/** Worst first; among equals, the later entry (newer) first. */
export function orderBannerItems<T extends Pick<ComposerBannerStackItem, "priority" | "variant">>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => bannerPriority(a.item) - bannerPriority(b.item) || b.index - a.index)
    .map((x) => x.item);
}

export function ComposerBannerStack({ className, items }: { readonly className?: string; readonly items: ReadonlyArray<ComposerBannerStackItem> }) {
  if (items.length === 0) return null;
  return (
    <div className={className} data-composer-banner-stack="true">
      <div className="flex flex-col gap-1.5">
        {orderBannerItems(items).map((item) => (
          <ComposerBannerStackAlert key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function ComposerBannerStackAlert({ item }: { readonly item: ComposerBannerStackItem }) {
  return (
    <ComposerBanner.Root
      role={item.variant === "error" || item.variant === "warning" ? "alert" : "status"}
      variant={item.variant}
      density="comfortable"
      data-banner-id={item.id}
    >
      <ComposerBanner.Row layout="wrap-actions">
        <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">{item.icon}</ComposerBanner.Icon>
        <ComposerBanner.Content className="flex-wrap">
          <span className="min-w-0 font-medium leading-6">{item.title}</span>
          {item.description ? <span className="min-w-0 text-muted-foreground">{item.description}</span> : null}
        </ComposerBanner.Content>
        {item.actions || item.onDismiss ? (
          <ComposerBanner.Actions className="ms-auto">
            {item.actions}
            {item.onDismiss ? (
              <ComposerBanner.Dismiss aria-label={item.dismissLabel ?? "Dismiss"} onClick={item.onDismiss} />
            ) : null}
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
      {item.children ? <ComposerBanner.Children>{item.children}</ComposerBanner.Children> : null}
    </ComposerBanner.Root>
  );
}
