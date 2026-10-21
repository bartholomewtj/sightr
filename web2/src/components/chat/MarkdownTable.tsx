// Adapted from T3 Code apps/web/src/components/chat/MarkdownTable.tsx @ 688ee52f0e8f (MIT, see
// THIRD_PARTY.md). Sightr's own body: a plain scrolling container instead of T3's ScrollArea, a
// window `resize` listener instead of `observeResize`, and the copy formats go through
// `lib/markdown-clipboard` and `MessageCopyButton`'s `copyText` (which falls back to
// `execCommand("copy")` where the Clipboard API is missing — a phone browser or a lost permission).
// Same two controls as upstream: a wrap/expand toggle that only appears when a cell is actually
// clipped, and a Copy menu (Markdown or CSV).
import { CheckIcon, CopyIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import type { ExtraProps } from "react-markdown";

import {
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "~/lib/markdown-clipboard";
import { cn } from "~/lib/utils";

import { copyText } from "./MessageCopyButton";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const COPIED_MS = 1500;

/**
 * Whether any cell is clipped in the unwrapped layout. Only then does the wrap toggle change
 * anything, so a short table hides it. Measures with the container briefly unwrapped and restores it
 * before the browser paints.
 */
function tableHasClippedCells(container: HTMLElement, table: HTMLTableElement): boolean {
  const scrollLeft = container.scrollLeft;
  const previous = container.dataset.expanded;
  container.dataset.expanded = "false";
  try {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        if (cell.scrollWidth > cell.clientWidth) return true;
      }
    }
    return false;
  } finally {
    if (previous === undefined) delete container.dataset.expanded;
    else container.dataset.expanded = previous;
    // The unwrapped layout can be narrower and clamp a sideways scroll.
    if (scrollLeft > 0) container.scrollLeft = scrollLeft;
  }
}

export function MarkdownTable({
  node: _node,
  children,
  className,
  ...props
}: ComponentProps<"table"> & ExtraProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hasClippedCells, setHasClippedCells] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandLabel = expanded ? "Collapse table cells" : "Expand table cells";

  const measureClippedCells = useCallback(() => {
    const container = containerRef.current;
    const table = tableRef.current;
    if (!container || !table) return;
    setHasClippedCells(tableHasClippedCells(container, table));
  }, []);

  // A streamed cell can grow until it clips while the table keeps its size, so remeasure after every
  // render, not only on resize; a column width can change without this table rendering, hence the
  // window listener (no ResizeObserver: this runs in jsdom too).
  useLayoutEffect(measureClippedCells);

  useEffect(() => {
    window.addEventListener("resize", measureClippedCells);
    return () => window.removeEventListener("resize", measureClippedCells);
  }, [measureClippedCells]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  const handleCopy = (format: "markdown" | "csv") => {
    const table = tableRef.current;
    if (!table) return;
    const text =
      format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table);
    void copyText(text).then((ok) => {
      if (!ok) return;
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
      setCopied(true);
      copiedTimerRef.current = setTimeout(() => {
        setCopied(false);
        copiedTimerRef.current = null;
      }, COPIED_MS);
    });
  };

  return (
    <div
      ref={containerRef}
      className="chat-markdown-table-container max-w-full overflow-x-auto"
      data-expanded={expanded ? "true" : "false"}
    >
      <table
        ref={tableRef}
        {...props}
        className={cn(
          "border-collapse",
          expanded
            ? "whitespace-normal"
            : "whitespace-nowrap [&_td]:max-w-[22rem] [&_td]:overflow-hidden [&_td]:text-ellipsis [&_th]:max-w-[22rem] [&_th]:overflow-hidden [&_th]:text-ellipsis",
          className,
        )}
      >
        {children}
      </table>
      <div className="mt-0.5 flex items-center justify-between select-none pointer-coarse:min-h-11">
        {hasClippedCells ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant={expanded ? "secondary" : "ghost-muted"}
                  size="icon-xs"
                  aria-pressed={expanded}
                  onClick={() => setExpanded((value) => !value)}
                  aria-label={expandLabel}
                />
              }
            >
              {expanded ? <Minimize2Icon className="size-3" /> : <Maximize2Icon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{expandLabel}</TooltipPopup>
          </Tooltip>
        ) : (
          <span />
        )}
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button type="button" variant="ghost-muted" size="icon-xs" aria-label="Copy table" />
                  }
                />
              }
            >
              {copied ? <CheckIcon className="size-3 text-primary" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copied ? "Copied" : "Copy table"}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}
