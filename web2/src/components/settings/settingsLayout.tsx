// Adapted from T3 Code apps/web/src/components/settings/settingsLayout.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Kept: `SettingsSection` (a titled `SettingsGroup`), `SettingsRow` (title, description, status, a
// control on the right that drops under the text on a narrow row, children below) and
// `SettingsPageContainer` (the scrolling, readable-width column, T3's WorkspacePageContainer inlined).
// Dropped: settings search targets, environment/project scopes, inheritance and reset buttons. Sightr
// has one bridge and per-device settings; a row the device may not change takes `disabled`, which
// greys it as T3's `aria-disabled` rows do. The page scroll keeps the bottom safe area clear. `SettingsChoice` buttons may shrink (tighter padding below `sm`) so
// a four-way choice still fits a 360 px phone at the largest text size.
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "../../lib/utils";
import { SettingsGroup } from "./SettingsGroup";

export function SettingsSection({
  title,
  hideTitle = false,
  icon,
  headerAction,
  variant = "grouped",
  children,
  className,
  ...sectionProps
}: Omit<ComponentPropsWithoutRef<"section">, "title"> & {
  title: string;
  hideTitle?: boolean;
  icon?: ReactNode;
  headerAction?: ReactNode;
  variant?: "grouped" | "plain";
  children: ReactNode;
}) {
  return (
    <section {...sectionProps} aria-label={title} className={cn(!hideTitle && "space-y-2.5", className)}>
      {hideTitle ? (
        <h2 className="sr-only">{title}</h2>
      ) : (
        <div className="flex min-h-7 items-start justify-between gap-4 px-3 sm:px-4">
          <h2 className="flex min-h-7 items-center gap-2 text-sm font-normal text-foreground/70">
            {icon}
            {title}
          </h2>
          <div className="flex min-h-7 min-w-7 items-center justify-end">{headerAction}</div>
        </div>
      )}
      <SettingsGroup variant={variant}>{children}</SettingsGroup>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  status,
  control,
  disabled = false,
  children,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  control?: ReactNode;
  /** The device may read this row but not change it. */
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      {...rowProps}
      data-slot="settings-row"
      aria-disabled={disabled || undefined}
      className={cn(
        "@container/settings-row rounded-xl px-3 sm:px-4 aria-disabled:opacity-64",
        children ? "pt-3 pb-3" : "py-3",
        className,
      )}
    >
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
          </div>
          {description ? <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">{description}</p> : null}
          {status ? <div className="pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingsPageContainer({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="flex-1 overflow-y-auto overscroll-y-contain" data-settings-page-scroll>
      <div className={cn("mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 pt-6 pb-[max(env(safe-area-inset-bottom),3rem)] sm:px-6", className)}>{children}</div>
    </div>
  );
}

/** A small radio group (Sightr's): the theme, Enter and follow-up choices. 44 px targets on a phone. */
export function SettingsChoice<T extends string>({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; icon?: ReactNode }>;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-full min-w-0 gap-0.5 rounded-lg bg-input/40 p-0.5 @min-[32rem]/settings-row:w-auto">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-sm whitespace-nowrap transition-colors sm:min-h-8 sm:px-3 disabled:opacity-64",
              selected ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
