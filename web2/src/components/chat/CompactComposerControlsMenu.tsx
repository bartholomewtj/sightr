// Adapted from T3 Code apps/web/src/components/chat/CompactComposerControlsMenu.tsx @ db5919d87daffd2d2db16e72602a586feb002adb (MIT, THIRD_PARTY.md).
// Only the Access radio group is kept, fed from the thread's capability list (T08's live permission
// mode). No chat/plan toggle (plan is one of the harness's modes) and no traits (effort and model are
// fixed at spawn). The trigger names the current mode instead of "…", since a phone has no hover. A
// destructive mode is not switched from here: `onModeChange` gets it, and the composer asks to confirm.
import { memo } from "react";
import { Loader2Icon, ShieldIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import type { PermissionModeOption } from "./ChatComposer.logic";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";

const TOUCH_ROW = "pointer-coarse:min-h-11 pointer-coarse:sm:min-h-11";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  runtimeMode: string | undefined;
  runtimeModeOptions: readonly PermissionModeOption[];
  /** Why the mode cannot change now; the menu still opens and says so. */
  blockedReason: string | null;
  /** A switch is on its way to the bridge. */
  switching: boolean;
  size?: "sm" | "xs";
  onRuntimeModeChange: (mode: string) => void;
}) {
  const size = props.size ?? "sm";
  const current = props.runtimeModeOptions.find((o) => o.id === props.runtimeMode);
  const label = props.switching ? "Switching…" : (current?.label ?? "Mode");

  return (
    <Menu>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            className="min-w-0 shrink"
            aria-label={`Permission mode: ${current?.label ?? "unknown"}`}
            data-composer-control="permission-mode"
            data-mode={props.runtimeMode ?? ""}
          />
        }
      >
        {props.switching ? (
          <Loader2Icon aria-hidden="true" className={cn("shrink-0 animate-spin", size === "xs" ? "size-3" : "size-4")} />
        ) : (
          <ComposerControlIcon icon={ShieldIcon} size={size} className={current?.destructive ? "text-destructive" : undefined} />
        )}
        <span className="min-w-0 max-w-[7.5rem] truncate">{label}</span>
        <ComposerControlChevron size={size} />
      </MenuTrigger>
      <MenuPopup align="start" side="top">
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Permission mode</div>
        {props.blockedReason ? (
          <p className="max-w-64 px-2 pb-1.5 text-muted-foreground text-xs" data-mode-blocked="">
            {props.blockedReason}
          </p>
        ) : null}
        <MenuRadioGroup
          value={props.runtimeMode ?? ""}
          onValueChange={(value) => {
            if (typeof value !== "string" || !value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value);
          }}
        >
          {props.runtimeModeOptions.map((option) => (
            <MenuRadioItem
              key={option.id}
              value={option.id}
              disabled={props.blockedReason !== null || props.switching}
              // Sightr: a phone user expects the menu to close on a pick (Base UI keeps radio menus open).
              closeOnClick
              className={cn(TOUCH_ROW, option.destructive && "text-destructive-foreground")}
            >
              <span className="flex items-center justify-between gap-3">
                <span>{option.label}</span>
                {option.destructive ? <span className="text-muted-foreground text-xs">asks first</span> : null}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
