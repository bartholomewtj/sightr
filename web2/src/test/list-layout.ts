/**
 * jsdom has no layout, so `@legendapp/list` measures every element as 0×0 and renders no rows. This
 * gives scroll containers a 600 px viewport and every other element a 40 px height, enough for the
 * virtualizer to compute a window, and keeps a scroll position per element. Call it in a test;
 * vi.restoreAllMocks undoes the measurements (the scrollTo/scrollBy stand-ins stay, harmlessly).
 */
import { vi } from "vitest";

export const VIEWPORT = 600;
export const ROW = 40;

function isScroller(el: Element): boolean {
  const style = (el as HTMLElement).style;
  return style?.overflowY === "auto" || style?.overflow === "auto";
}

export function installListLayout(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const h = isScroller(this) ? VIEWPORT : ROW;
    return { x: 0, y: 0, top: 0, left: 0, bottom: h, right: 400, width: 400, height: h, toJSON() {} } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isScroller(this) ? VIEWPORT : ROW;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => 400);
  // Scroll position: jsdom keeps none. A scroller's content is as tall as its measured children say.
  const tops = new WeakMap<Element, number>();
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
    return tops.get(this) ?? 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: Element, value: number) {
    tops.set(this, Math.max(0, value));
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return isScroller(this) ? Math.max(VIEWPORT, this.firstElementChild ? contentHeight(this.firstElementChild) : 0) : ROW;
  });
  vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(() => 400);
  Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number, y?: number) {
    const top = typeof options === "number" ? y : options?.top;
    if (typeof top === "number") this.scrollTop = top;
    this.dispatchEvent(new Event("scroll"));
  } as Element["scrollTo"];
  Element.prototype.scrollBy = function (this: Element, options?: ScrollToOptions | number, y?: number) {
    const dy = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
    this.scrollTop = this.scrollTop + dy;
    this.dispatchEvent(new Event("scroll"));
  } as Element["scrollBy"];
}

/** The content height LegendList laid out: the largest px `height` among the container's first levels. */
function contentHeight(el: Element): number {
  let max = 0;
  const visit = (node: Element, depth: number) => {
    const h = (node as HTMLElement).style?.height ?? "";
    if (h.endsWith("px")) max = Math.max(max, parseFloat(h));
    if (depth < 2) for (const child of node.children) visit(child, depth + 1);
  };
  visit(el, 0);
  return max;
}
