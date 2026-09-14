import { Copy, Download } from "lucide-react";
import { BottomSheet } from "@/components/ui/sheet";
import { ActionPopover } from "@/components/ui/popover";
import { ActionRow } from "@/components/action-sheet-rows";
import { useDesktop } from "@/lib/desktop";
import { downloadFileUrl } from "@/lib/api";
import { useState, type MouseEvent } from "react";
import { baseName } from "@/lib/format";

export function FileActionsSheet({ open, path, onClose, anchor = null }: { open: boolean; path: string | null; onClose: () => void; anchor?: { x: number; y: number } | null }) {
  const desktop = useDesktop().on;
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!path) return;
    try { await navigator.clipboard.writeText(path); } catch { const t = document.createElement("textarea"); t.value = path; document.body.appendChild(t); t.select(); if (typeof document.execCommand === "function") document.execCommand("copy"); t.remove(); }
    setCopied(true); setTimeout(() => { setCopied(false); onClose(); }, 1500);
  }
  function download(e: MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    if (path) window.location.assign(downloadFileUrl(path));
    onClose();
  }
  const body = <div className="flex flex-col gap-1">
    <a className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-accent active:bg-muted" href={path ? downloadFileUrl(path) : "#"} onClick={download}><Download className="size-4 shrink-0 text-muted-foreground" />Download</a>
    <ActionRow icon={<Copy className="size-4 shrink-0 text-muted-foreground" />} label={copied ? "Copied" : "Copy path"} onClick={() => void copy()} />
  </div>;
  const title = path ? `Folder ${baseName(path)}` : "Folder";
  return desktop ? <ActionPopover open={open} onClose={onClose} anchor={anchor} title={title}>{body}</ActionPopover> : <BottomSheet open={open} onClose={onClose} title={title}>{body}</BottomSheet>;
}
