import { Folder, LayoutGrid, Settings } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

import { cn } from "@/lib/utils";
import { filesPath, homePath, settingsPath } from "@/lib/nav";

interface BottomNavProps {
  /** Show the Files destination when a work root is configured. */
  files: boolean;
}

// The bottom tab bar: the app's top-level destinations, always one tap away — the way a phone app
// keeps its main sections reachable without a stack of back-taps. Screens BELOW a destination (a
// pane, a file preview) don't render this; they get a "‹" back in the header instead
// (AppHeader.onBack). Which destination is lit is read from the URL, so a deep link is right too.
export function BottomNav({ files }: BottomNavProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const items = [
    {
      key: "spaces",
      label: "Spaces",
      icon: LayoutGrid,
      to: homePath(),
      on: pathname === "/",
    },
    ...(files ? [{ key: "files", label: "Files", icon: Folder, to: filesPath(), on: pathname.startsWith("/files") }] : []),
    { key: "settings", label: "Settings", icon: Settings, to: settingsPath(), on: pathname === "/settings" },
  ];
  return (
    <nav
      aria-label="Main"
      className="sticky bottom-0 z-20 mx-auto flex w-full max-w-screen-sm shrink-0 border-t-2 border-border bg-muted pb-[env(safe-area-inset-bottom)]"
    >
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          aria-current={it.on ? "page" : undefined}
          onClick={() => {
            // replace, not push: a tab bar switches sections, it doesn't drill down. Otherwise the
            // phone's back gesture retraces every tab you touched before it leaves the app.
            if (!it.on) navigate(it.to, { replace: true });
          }}
          className={cn(
            "relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] font-medium transition-colors active:bg-background/40",
            it.on ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <span className="relative">
            <it.icon className="size-5" strokeWidth={it.on ? 2.25 : 1.75} />
          </span>
          <span className="flex max-w-full flex-col items-center leading-tight">
            <span>{it.label}</span>
          </span>
        </button>
      ))}
    </nav>
  );
}
