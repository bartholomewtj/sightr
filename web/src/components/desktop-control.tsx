import { Monitor, MonitorSmartphone, Smartphone } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { setLayout, setTyping, useDesktop, type DesktopLayout, type DesktopTyping } from "@/lib/desktop";
import { cn } from "@/lib/utils";

const LAYOUTS: ReadonlyArray<{ value: DesktopLayout; label: string; icon: LucideIcon }> = [
  { value: "system", label: "System", icon: MonitorSmartphone },
  { value: "on", label: "On", icon: Monitor },
  { value: "off", label: "Off", icon: Smartphone },
];

export function DesktopControl() {
  const prefs = useDesktop();
  return <Card className="gap-0 py-0">
    <div className="flex items-center justify-between gap-4 p-4"><div className="flex min-w-0 items-start gap-3"><Monitor className="mt-0.5 size-5 shrink-0 text-muted-foreground" /><div className="min-w-0"><div className="font-medium">Desktop mode</div><p className="text-sm text-muted-foreground">Sidebar layout and direct keyboard typing.</p></div></div></div>
    <div role="radiogroup" aria-label="Desktop mode" className="flex gap-1 border-t border-border/60 p-2">
      {LAYOUTS.map(({ value, label, icon: Icon }) => <button key={value} type="button" role="radio" aria-checked={prefs.layout === value} onClick={() => setLayout(value)} className={cn("flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm transition-colors", prefs.layout === value ? "bg-primary font-medium text-primary-foreground" : "text-muted-foreground active:bg-muted")}><Icon className="size-4 shrink-0" />{label}</button>)}
    </div>
    {prefs.on && <div className="border-t border-border/60"><div className="flex items-center justify-between px-4 py-3"><span className="text-sm font-medium">Typing surface</span><div className="flex gap-1">{(["composer", "direct"] as DesktopTyping[]).map((typing) => <button type="button" key={typing} onClick={() => setTyping(typing)} className={`rounded px-2 py-1 text-sm ${prefs.typing === typing ? "bg-accent font-medium" : "text-muted-foreground"}`}>{typing[0]!.toUpperCase() + typing.slice(1)}</button>)}</div></div><div className="border-t border-border/60 px-4 py-3"><div className="text-sm font-medium">Idle pause</div><p className="text-xs text-muted-foreground">2 h on desktop. Pauses polling; it does not lock the shell — use your OS screen lock.</p></div></div>}
  </Card>;
}
