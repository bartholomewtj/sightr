// Adapted from T3 Code apps/web/src/components/chat/ComposerBanner.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: flat house surfaces (tokens.md rules out glass, blur and the seam mask), so Surface, Peek,
// Dock and Column are gone; Root/Row/Icon/Content/Actions/Children/Scroll/Count/Body/ToggleIcon/Dismiss
// keep T3's names and slots so adopted banner rows port with class edits only. Scroll is a plain
// overflow box (no ScrollArea fade). Touch: list rows are 44 px and action buttons sit further apart.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ChevronDownIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export type ComposerBannerVariant = "default" | "error" | "info" | "success" | "warning" | "you";

const variantColors: Record<ComposerBannerVariant, string> = {
  default: "border-border bg-card",
  error: "border-destructive/40 bg-error-surface",
  info: "border-border bg-card",
  success: "border-border bg-card",
  warning: "border-warning/40 bg-warning-surface",
  // The page's one "you" step (a request waiting on the operator): accent fill and border.
  you: "border-you bg-you-soft",
};

function Attachment({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="composer-banner-attachment" className={cn("w-full", className)} {...props} />;
}

function Root({
  className,
  density = "default",
  variant = "default",
  ...props
}: ComponentProps<"div"> & {
  density?: "default" | "comfortable" | "spacious";
  variant?: ComposerBannerVariant;
}) {
  return (
    <div
      data-slot="composer-banner"
      data-variant={variant}
      className={cn(
        "min-w-0 rounded-xl border px-1 py-1 text-xs/4 [--composer-banner-icon-column:--spacing(7)] sm:[--composer-banner-icon-column:--spacing(6)]",
        density === "comfortable" && "py-1.5",
        density === "spacious" && "px-3 py-3",
        variantColors[variant],
        className,
      )}
      {...props}
    />
  );
}

function Row({
  className,
  render,
  layout = "inline",
  ...props
}: useRender.ComponentProps<"div"> & {
  layout?: "inline" | "wrap-actions" | "approval";
}) {
  const rowProps = {
    className: cn(
      "group/banner-row grid min-h-(--composer-banner-icon-column) w-full min-w-0 grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)_auto] items-center gap-x-1 text-start",
      "not-has-[>[data-slot=composer-banner-actions]]:grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)]",
      "[&:is(button)]:cursor-pointer [&:is(button)]:rounded-md [&:is(button)]:focus-visible:outline-2 [&:is(button)]:focus-visible:-outline-offset-2 [&:is(button)]:focus-visible:outline-ring",
      layout === "wrap-actions" && "flex flex-wrap",
      layout === "approval" && "items-start gap-x-2 gap-y-3",
      className,
    ),
    "data-composer-banner-row": "true",
    "data-composer-banner-layout": layout,
  };
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(rowProps, props),
  });
}

function Icon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="composer-banner-icon"
      className={cn(
        "flex w-(--composer-banner-icon-column) min-w-0 flex-none items-center justify-center text-muted-foreground [&>svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

function Content({ className, ...props }: ComponentProps<"span">) {
  return (
    <span data-slot="composer-banner-content" className={cn("flex min-w-0 flex-1 items-center gap-1", className)} {...props} />
  );
}

function Separator() {
  return (
    <span aria-hidden data-slot="composer-banner-separator" className="mx-1 inline-block flex-none text-muted-foreground/40">
      ·
    </span>
  );
}

function Actions({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="composer-banner-actions"
      className={cn("flex flex-wrap items-center justify-end gap-1 pointer-coarse:gap-2", className)}
      {...props}
    />
  );
}

function Children({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    render,
    // Touch: a 44 px row, so its 44 px button hit areas (ui/button `pointer-coarse:after`) stay in their own row.
    props: mergeProps<"div">(
      { className: cn("grid gap-px [&_[data-composer-banner-row]]:min-h-5 pointer-coarse:[&_[data-composer-banner-row]]:min-h-11", className) },
      props,
    ),
  });
}

function Scroll({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("h-auto max-h-[min(24rem,40dvh)] overflow-y-auto", className)} {...props} />;
}

function Count({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex min-w-(--composer-banner-icon-column,1em) flex-none justify-center font-medium text-muted-foreground tabular-nums",
        className,
      )}
      {...props}
    />
  );
}

function Body({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-w-0 ps-8 sm:ps-7", className)} {...props} />;
}

function ToggleIcon({ expanded }: { expanded: boolean }) {
  return (
    <span aria-hidden className="pointer-events-none inline-flex size-6 items-center justify-center text-muted-foreground">
      <ChevronDownIcon className={cn("size-3.5", !expanded && "rotate-180")} />
    </span>
  );
}

function Dismiss({ className, children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button size="icon-xs" variant="ghost" className={className} {...props}>
      {children ?? <XIcon className="size-3.5" />}
    </Button>
  );
}

export const ComposerBanner = {
  Attachment,
  Root,
  Row,
  Icon,
  Content,
  Separator,
  Actions,
  Children,
  Scroll,
  Count,
  Body,
  ToggleIcon,
  Dismiss,
};
