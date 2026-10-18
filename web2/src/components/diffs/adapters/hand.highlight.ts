// Sightr code (T25). highlight.js (BSD-3-Clause) for the hand-rolled adapter: the core and one grammar per
// language load on demand, in the adapter's lazy chunk. highlight.js runs on the main thread with the
// browser's own regex engine: no worker, no WASM. The output HTML is read back into React text nodes
// (never injected as markup), so pane text cannot become markup.
import type { ReactNode } from "react";
import { createElement } from "react";
import type { ParsedHunk, ParsedLine, ParsedPatchFile } from "../parsePatch.ts";
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

/** Highlights each hunk twice (new side for context and additions, old side for removals) so multi-line tokens carry over. */
export async function highlightFile(file: ParsedPatchFile, path: string, isCancelled: () => boolean): Promise<Map<ParsedLine, ReactNode[]> | null> {
  const lang = languageForPath(path);
  if (!lang) return null;
  const hljs = await hljsFor(lang);
  const out = new Map<ParsedLine, ReactNode[]>();
  const side = (hunk: ParsedHunk, drop: ParsedLine["kind"]) => {
    const lines = hunk.lines.filter((l) => l.kind !== drop);
    const code = lines.map((l) => (l.text.length > MAX_LINE ? "" : l.text.replace(/\r$/, ""))).join("\n");
    const nodes = htmlToLines(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value);
    lines.forEach((l, i) => {
      if ((drop === "add" ? l.kind === "del" : true) && l.text.length <= MAX_LINE) out.set(l, nodes[i] ?? []);
    });
  };
  for (const hunk of file.hunks) {
    if (isCancelled()) return null;
    side(hunk, "del"); // context + additions, in new-file order
    if (hunk.lines.some((l) => l.kind === "del")) side(hunk, "add"); // context + removals; only the removals are kept
    await tick();
  }
  return out;
}
