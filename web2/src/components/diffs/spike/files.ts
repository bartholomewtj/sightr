// Sightr code (T25). A multi-file patch to the per-file patches the seam takes.
import { parsePatch, type ParsedPatchFile } from "../parsePatch.ts";

export type SpikeFile = { path: string; patch: string; parsed: ParsedPatchFile };

export function splitFiles(patch: string): SpikeFile[] {
  return patch
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.startsWith("diff --git "))
    .map((chunk) => {
      const parsed = parsePatch(chunk)[0] as ParsedPatchFile;
      return { path: parsed.path, patch: chunk, parsed };
    });
}

/** Mounted DOM nodes under `root`, shadow roots included (pierre draws inside one). */
export function countNodes(root: ParentNode): number {
  let n = 0;
  const walk = (node: ParentNode) => {
    for (const el of Array.from(node.querySelectorAll("*"))) {
      n++;
      const shadow = (el as Element).shadowRoot;
      if (shadow) walk(shadow);
    }
  };
  walk(root);
  return n;
}

/** Lines the adapter itself drew: not the seam's Suspense fallback, nor an adapter's plain-text stand-in. */
export function adapterLines(root: ParentNode): Element[] {
  return queryDeep(root, "[data-diff-line], [data-content] [data-line]").filter((e) => !e.closest("[data-diff-fallback]"));
}

/** Elements matching `selector` under `root`, shadow roots included. */
export function queryDeep(root: ParentNode, selector: string): Element[] {
  const out: Element[] = Array.from(root.querySelectorAll(selector));
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const shadow = (el as Element).shadowRoot;
    if (shadow) for (const hit of queryDeep(shadow, selector)) out.push(hit); // not push(...hits): thousands of arguments overflow the stack
  }
  return out;
}
