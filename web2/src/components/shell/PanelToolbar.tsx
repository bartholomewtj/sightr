import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { RIGHT_PANEL_ICON } from "@/components/RightPanelTabs";
import { guardPanelLeave } from "@/components/right-panel/leaveGuard";
import { useLayout } from "@/hooks/useLayout";
import { KEYBINDINGS, shortcutLabelForCommand } from "@/keybindings";
import {
  RIGHT_PANEL_KINDS,
  RIGHT_PANEL_LABEL,
  useRightPanelStore,
  type RightPanelKind,
} from "@/rightPanelStore";

const KIND_COMMAND: Record<RightPanelKind, Parameters<typeof shortcutLabelForCommand>[1]> = {
  terminal: "terminal.toggle",
  files: "rightPanel.files",
  git: "rightPanel.git",
  diff: "diff.toggle",
};

export interface PanelToolbarProps {
  cli?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function PanelToolbar({ cli = false, className, ariaLabel }: PanelToolbarProps) {
  const desktop = useLayout() === "desktop";
  const isOpen = useRightPanelStore((s) => s.isOpen);
  const activeSurfaceId = useRightPanelStore((s) => s.activeSurfaceId);
  const sheet = useRightPanelStore((s) => s.sheet);
  const open = useRightPanelStore((s) => s.open);
  const close = useRightPanelStore((s) => s.close);
  const openSheet = useRightPanelStore((s) => s.openSheet);
  const closeSheet = useRightPanelStore((s) => s.closeSheet);

  const kinds = !desktop && cli
    ? RIGHT_PANEL_KINDS.filter((k) => k !== "terminal")
    : RIGHT_PANEL_KINDS;

  const handleClick = (kind: RightPanelKind) => {
    if (desktop) {
      const active = isOpen && activeSurfaceId === kind;
      guardPanelLeave(() => (active ? close() : open(kind)));
    } else {
      const active = sheet === kind;
      guardPanelLeave(() => (active ? closeSheet() : openSheet(kind)));
    }
  };

  const groupLabel = ariaLabel ?? (desktop ? "Right panel" : "Thread tools");

  return (
    <div
      role="group"
      aria-label={groupLabel}
      className={cn("flex items-center gap-0.5", !desktop && "-mr-1", className)}
    >
      {kinds.map((kind) => {
        const Icon = RIGHT_PANEL_ICON[kind];
        const label = RIGHT_PANEL_LABEL[kind];
        const active = desktop ? isOpen && activeSurfaceId === kind : sheet === kind;
        const command = KIND_COMMAND[kind];
        const shortcut = shortcutLabelForCommand(KEYBINDINGS, command);
        const title = shortcut ? `${label} (${shortcut})` : label;

        return (
          <Button
            key={kind}
            id={desktop ? `panel-toolbar-tab-${kind}` : undefined}
            size="icon-sm"
            variant="ghost-muted"
            aria-label={label}
            aria-pressed={active}
            aria-controls={desktop ? "right-panel-surface" : undefined}
            data-pressed={active ? "" : undefined}
            title={title}
            className={cn(active && "bg-accent text-foreground")}
            onClick={() => handleClick(kind)}
          >
            <Icon className="size-4" />
          </Button>
        );
      })}
    </div>
  );
}
