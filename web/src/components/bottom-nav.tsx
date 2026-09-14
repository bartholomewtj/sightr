import { Activity, Folder, LayoutGrid, Settings } from "lucide-react";
import { useLocation, useNavigate } from "react-router";

import { cn } from "@/lib/utils";
import { filesPath, homePath, settingsPath, tracesPath } from "@/lib/nav";

interface BottomNavProps {
  /** Show the Traces destination — true when any workspace advertises SSSF traces. */
  traces: boolean;
  /** Repo names with a live ADW — dotted on the Traces tab, named under the label. */
  liveRepos?: string[];
  /** Show the Files destination when a work root is configured. */
  files: boolean;
}

// The bottom tab bar: the app's top-level destinations, always one tap away — the way a phone app
// keeps its main sections reachable without a stack of back-taps. Screens BELOW a destination (a
// pane, one repo's traces) don't render this; they get a "‹" back in the header instead
// (AppHeader.onBack). Which destination is lit is read from the URL, so a deep link is right too.
export function BottomNav({ traces, liveRepos = [], files }: BottomNavProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const live = traces ? liveRepos : [];
  const items = [
    {
      key: "spaces",
      label: "Spaces",
      icon: LayoutGrid,
      to: homePath(),
      on: pathname === "/",
    },
    ...(traces
      ? [{ key: "traces", label: "Traces", icon: Activity, to: tracesPath(), on: pathname.startsWith("/traces") }]
      : []),
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
          aria-label={it.key === "traces" && live.length ? `Traces, ${live.join(", ")} running` : undefined}
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
            {it.key === "traces" && live.length > 0 && (
              <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-status-running" />
            )}
          </span>
          <span className="flex max-w-full flex-col items-center leading-tight">
            <span>{it.label}</span>
            {it.key === "traces" && live.length > 0 && (
              <span className="max-w-[5.5rem] truncate text-[10px] font-semibold text-status-running">{live.join(", ")}</span>
            )}
          </span>
        </button>
      ))}
    </nav>
  );
}
