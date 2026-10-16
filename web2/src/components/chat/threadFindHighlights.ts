// Adapted from T3 Code apps/web/src/components/chat/threadFindHighlights.ts @ e3b35d1b (MIT, see
// THIRD_PARTY.md). Kept: ranges over the mounted rows' text nodes, painted with the CSS Custom
// Highlight API (no DOM rewriting inside React's rows), repainted on a MutationObserver as the
// virtualized list mounts rows, one "active" highlight for the focused match. Changed: the scope is
// the whole row minus `[data-thread-find-ignore]` (timestamps, timers) and screen-reader-only text,
// matches come from v1's matcher, and the active row also gets `data-thread-find-active` (a ring, and
// the only mark where the browser has no `CSS.highlights`). Fold reveal is the navigation hook's job.
import { findMatches } from "@v1/lib/find";
import { useEffect, useRef } from "react";

export const THREAD_FIND_HIGHLIGHT_NAME = "sightr-thread-find";
export const THREAD_FIND_ACTIVE_HIGHLIGHT_NAME = "sightr-thread-find-active";
const ROW_SELECTOR = "[data-timeline-row-id]";
const IGNORE_SELECTOR = "[data-thread-find-ignore], .sr-only, svg, [role='toolbar']";
const BLOCK_TAGS = new Set([
  "address", "article", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption", "figure", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "li", "ol", "p", "pre", "section", "table", "tbody", "td", "th", "thead",
  "tr", "ul", "button", "summary",
]);

/** Every occurrence of `query` in `scope`'s visible text, as DOM ranges in document order. */
export function collectThreadFindRanges(scope: HTMLElement, query: string): Range[] {
  const needle = query.trim();
  if (!needle) return [];
  const ranges: Range[] = [];
  let text = "";
  let nodes: { node: Text; start: number; end: number }[] = [];
  const flush = () => {
    for (const hit of findMatches(text, needle)) {
      const start = nodes.find((n) => hit.start >= n.start && hit.start < n.end);
      const end = nodes.find((n) => hit.end > n.start && hit.end <= n.end);
      if (!start || !end) continue;
      const range = scope.ownerDocument.createRange();
      range.setStart(start.node, hit.start - start.start);
      range.setEnd(end.node, hit.end - end.start);
      ranges.push(range);
    }
    text = "";
    nodes = [];
  };
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const value = (node as Text).nodeValue ?? "";
      if (value === "") return;
      nodes.push({ node: node as Text, start: text.length, end: text.length + value.length });
      text += value;
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.matches(IGNORE_SELECTOR)) {
      flush();
      return;
    }
    const block = BLOCK_TAGS.has(element.tagName.toLowerCase());
    if (block) flush();
    for (const child of element.childNodes) visit(child);
    if (block) flush();
  };
  visit(scope);
  flush();
  return ranges;
}

function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

function clearMarks(container: HTMLElement | null): void {
  if (highlightsSupported()) {
    CSS.highlights.delete(THREAD_FIND_HIGHLIGHT_NAME);
    CSS.highlights.delete(THREAD_FIND_ACTIVE_HIGHLIGHT_NAME);
  }
  container?.querySelectorAll("[data-thread-find-active]").forEach((el) => el.removeAttribute("data-thread-find-active"));
}

/**
 * Paint every hit in the mounted rows, mark the active row, and bring the active hit into view once
 * per `revealKey` (a navigation).
 */
export function useThreadFindHighlights(input: {
  container: HTMLElement | null;
  query: string;
  activeRowId: string | null;
  activeOccurrence: number;
  revealKey: string | null;
}): void {
  const { container, query, activeRowId, activeOccurrence, revealKey } = input;
  const revealed = useRef<string | null>(null);

  useEffect(() => {
    if (!container) return;
    const needle = query.trim();
    if (!needle) {
      clearMarks(container);
      return;
    }
    const paint = () => {
      container.querySelectorAll("[data-thread-find-active]").forEach((el) => {
        if (el.getAttribute("data-timeline-row-id") !== activeRowId) el.removeAttribute("data-thread-find-active");
      });
      const all: Range[] = [];
      let active: Range | null = null;
      for (const row of container.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
        const ranges = collectThreadFindRanges(row, needle);
        if (activeRowId !== null && row.getAttribute("data-timeline-row-id") === activeRowId) {
          row.setAttribute("data-thread-find-active", "true");
          active = ranges[activeOccurrence] ?? ranges[0] ?? null;
        }
        all.push(...ranges);
      }
      if (highlightsSupported()) {
        CSS.highlights.set(THREAD_FIND_HIGHLIGHT_NAME, new Highlight(...all.filter((r) => r !== active)));
        CSS.highlights.set(THREAD_FIND_ACTIVE_HIGHLIGHT_NAME, active ? new Highlight(active) : new Highlight());
      }
      if (active && revealKey !== null && revealed.current !== revealKey) {
        revealed.current = revealKey;
        active.startContainer.parentElement?.scrollIntoView?.({ block: "center", inline: "nearest" });
      }
    };
    let frame: number | null = null;
    const observer = new MutationObserver((mutations) => {
      // Timers tick every second; only rows mounting or text changing outside the ignored chrome count.
      const relevant = mutations.some((m) => {
        const target = m.target.nodeType === 1 ? (m.target as Element) : m.target.parentElement;
        return !target?.closest("[data-thread-find-ignore]");
      });
      if (!relevant || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        paint();
      });
    });
    observer.observe(container, { subtree: true, childList: true, characterData: true });
    paint();
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [container, query, activeRowId, activeOccurrence, revealKey]);

  // Closing the bar (or leaving the thread) clears every mark.
  useEffect(() => () => clearMarks(container), [container]);
}
