import { PanelLeftOpen } from "lucide-react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { KEYBINDINGS, shortcutLabelForCommand } from "@/keybindings";
import { useUiState } from "@/uiStateStore";

export function SidebarToggle({ className }: { className?: string }) {
  const setSidebarOpen = useUiState((s) => s.setSidebarOpen);
  const shortcut = shortcutLabelForCommand(KEYBINDINGS, "sidebar.toggle");
  const title = shortcut ? `Show sidebar (${shortcut})` : "Show the sidebar";

  return (
    <Button
      size="icon-sm"
      variant="ghost-muted"
      className={cn("-ml-1", className)}
      aria-label="Show the sidebar"
      title={title}
      onClick={() => setSidebarOpen(true)}
    >
      <PanelLeftOpen className="size-4" />
    </Button>
  );
}
