// Sightr code (T25, windowed by T27). highlight.js (BSD-3-Clause) for the hand-rolled adapter: the core and one grammar per
// language load on demand, in the adapter's lazy chunk. Only the registered grammars outlive a component (module-level). highlight.js runs on the main thread with the
// browser's own regex engine: no worker, no WASM. The output HTML is read back into React text nodes
// (never injected as markup), so pane text cannot become markup.
import type { ReactNode } from "react";
import { createElement } from "react";
import type { ParsedLine } from "../parsePatch.ts";
import { languageForPath } from "./hand.langs.ts";

type Hljs = { highlight(code: string, o: { language: string; ignoreIllegals: boolean }): { value: string }; registerLanguage(n: string, f: unknown): void; getLanguage(n: string): unknown };

const GRAMMARS: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import("highlight.js/lib/languages/typescript"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  css: () => import("highlight.js/lib/languages/css"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  xml: () => import("highlight.js/lib/languages/xml"),
  ini: () => import("highlight.js/lib/languages/ini"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  bash: () => import("highlight.js/lib/languages/bash"),
  python: () => import("highlight.js/lib/languages/python"),
  rust: () => import("highlight.js/lib/languages/rust"),
};

let core: Promise<Hljs> | undefined;
async function hljsFor(lang: string): Promise<Hljs> {
  core ??= import("highlight.js/lib/core").then((m) => m.default as unknown as Hljs);
  const [hljs, grammar] = await Promise.all([core, (GRAMMARS[lang] as () => Promise<{ default: unknown }>)()]);
  if (!hljs.getLanguage(lang)) hljs.registerLanguage(lang, grammar.default);
  return hljs;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const unescape = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITIES[e] ?? e);

/** highlight.js HTML to one node list per source line; an open token is closed at each newline and reopened on the next. */
export function htmlToLines(html: string): ReactNode[][] {
  const lines: ReactNode[][] = [[]];
  const stack: string[] = [];
  let key = 0;
  const push = (text: string) => {
    if (!text) return;
    const out = lines[lines.length - 1] as ReactNode[];
    out.push(stack.length ? createElement("span", { key: key++, className: stack.join(" ") }, text) : text);
  };
  for (const part of html.split(/(<span class="[^"]*">|<\/span>)/)) {
    if (part.startsWith("<span")) stack.push(part.slice(13, -2));
    else if (part === "</span>") stack.pop();
    else {
      const segments = unescape(part).split("\n");
      segments.forEach((seg, i) => {
        if (i > 0) lines.push([]);
        push(seg);
      });
    }
  }
  return lines;
}

const MAX_LINE = 1000; // as T3's tokenizeMaxLineLength: a minified line is shown plain
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Lines per `highlight` call: a long added or deleted file is highlighted in slices, never one long task. */
export const HIGHLIGHT_SLICE = 200;

/**
 * Highlights one window's lines (T27), not the whole file: the new side (context and additions) and, when the
 * window has removals, the old side (context and removals) so a multi-line token carries within a slice.
 * Slices of at most {@link HIGHLIGHT_SLICE} lines, with a yield between them. A multi-line token cut at a
 * slice or window edge shows plain or part-coloured (highlight.js 11 has no continuation state). The result is
 * the caller's to hold and drop: nothing here keeps a per-file map. `null`: no grammar for the path, or cancelled.
 */
export async function highlightLines(lines: readonly ParsedLine[], path: string, isCancelled: () => boolean): Promise<Map<ParsedLine, ReactNode[]> | null> {
  const lang = languageForPath(path);
  if (!lang || lines.length === 0) return null;
  const hljs = await hljsFor(lang);
  const out = new Map<ParsedLine, ReactNode[]>();
  const side = async (drop: ParsedLine["kind"]) => {
    const own = lines.filter((l) => l.kind !== drop);
    for (let at = 0; at < own.length; at += HIGHLIGHT_SLICE) {
      if (isCancelled()) return false;
      const slice = own.slice(at, at + HIGHLIGHT_SLICE);
      const code = slice.map((l) => (l.text.length > MAX_LINE ? "" : l.text.replace(/\r$/, ""))).join("\n");
      const nodes = htmlToLines(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value);
      slice.forEach((l, i) => {
        if ((drop === "add" ? l.kind === "del" : true) && l.text.length <= MAX_LINE) out.set(l, nodes[i] ?? []);
      });
      await tick();
    }
    return true;
  };
  if (!(await side("del"))) return null; // context + additions, in new-file order
  if (lines.some((l) => l.kind === "del") && !(await side("add"))) return null; // context + removals; only the removals are kept
  return isCancelled() ? null : out;
}
