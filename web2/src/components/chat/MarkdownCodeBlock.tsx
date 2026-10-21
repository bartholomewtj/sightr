// Adapted from T3 Code apps/web/src/components/chat/MarkdownCodeBlock.tsx @ 688ee52f0e8f (MIT, see
// THIRD_PARTY.md). Sightr's `pre` renderer: T11's frame (a titled border with a "Wrap lines" toggle
// and Copy) plus highlight.js highlighting, and a `mermaid` fence that hands over to
// MarkdownMermaidCodeBlock (the diagram, or this same block as its fallback). T3's Shiki pipeline,
// its LRU cache and line-preserving streaming renderer, its pierre file icons and "Run in terminal"
// stay upstream.
//
// Highlighting: `highlight.js/lib/common` (the grammars the diffs adapter also draws on) is imported
// on demand — one shared chunk, so the chat's first paint does not carry it — and the highlighted
// HTML goes in through `dangerouslySetInnerHTML` (hljs escapes the code itself). The raw `code`
// string is what Copy hands over, so a copy is always the plain source. While a fence is still
// streaming — no closing fence in the `source` the host passed — the text stays plain: half a
// highlighted line flickers, half a plain one does not.
import { WrapTextIcon } from "lucide-react";
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import type { ExtraProps } from "react-markdown";

import { codeStartsWrapped, getTextPrefs } from "@/state/text-prefs";
import { cn } from "~/lib/utils";

import {
  extractCodeBlock,
  extractFenceLanguage,
  extractFenceTitle,
  extractPreCodeMeta,
  isClosedCodeFence,
} from "./MarkdownCodeBlock.logic";
import { MarkdownMermaidCodeBlock } from "./MarkdownMermaidCodeBlock";
import { MessageCopyButton } from "./MessageCopyButton";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type MarkdownCodeBlockProps = ComponentProps<"pre"> &
  ExtraProps & {
    /**
     * The whole markdown document, when the host has it. Only used to tell a finished fence from one
     * still streaming (`isClosedCodeFence`); without it every fence is treated as finished.
     */
    source?: string;
  };

/** The handful of hast fields these components read. */
interface HastNodeLike {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNodeLike[];
}

/** A hast node's text: its `text` children (react-markdown's `node` is hast, not React children). */
function hastPlainText(node: HastNodeLike | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastPlainText).join("");
}

function codeElementOf(node: unknown): HastNodeLike | undefined {
  return (node as HastNodeLike | undefined)?.children?.find(
    (child) => child?.type === "element" && child.tagName === "code",
  );
}

/** hast keeps `className` as an array of classes (react-markdown may hand over a plain string). */
function classNameText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string");
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  return undefined;
}

type Highlighter = {
  highlight: (code: string, options: { language: string }) => { value: string };
  highlightAuto: (code: string) => { value: string };
  getLanguage: (name: string) => unknown;
};

let highlighterLoad: Promise<Highlighter> | null = null;

/** The common grammars, one shared chunk for the whole app, loaded the first time a block renders. */
function loadHighlighter(): Promise<Highlighter> {
  highlighterLoad ??= import("highlight.js/lib/common").then(
    (module) => (module.default ?? module) as unknown as Highlighter,
  );
  return highlighterLoad;
}

function hasGrammar(highlighter: Highlighter, language: string): boolean {
  if (language === "text" || language === "plaintext" || language === "plain") return false;
  try {
    return highlighter.getLanguage(language) !== undefined;
  } catch {
    return false;
  }
}

/** Highlighted HTML for `code`, or null when it stays plain text. */
function highlightToHtml(
  highlighter: Highlighter,
  code: string,
  language: string,
): string | null {
  try {
    return hasGrammar(highlighter, language)
      ? highlighter.highlight(code, { language }).value
      : highlighter.highlightAuto(code).value;
  } catch {
    // An illegal token sequence, a broken grammar: the plain text is still readable.
    return null;
  }
}

/**
 * Highlighted HTML for a finished code block, or null while it is plain (loading, streaming, or a
 * failed highlight). Keyed on the exact code and language, so a streamed update never shows the
 * previous highlight.
 */
function useHighlightedHtml(code: string, language: string, enabled: boolean): string | null {
  const key = `${language}\u0000${code}`;
  const [result, setResult] = useState<{ key: string; html: string } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadHighlighter()
      .then((highlighter) => {
        if (cancelled) return;
        const html = highlightToHtml(highlighter, code, language);
        if (html !== null) setResult({ key, html });
      })
      .catch(() => {
        // No highlighter (an offline chunk): plain text is the whole feature.
      });
    return () => {
      cancelled = true;
    };
  }, [code, enabled, key, language]);

  return result !== null && result.key === key ? result.html : null;
}

/**
 * Code blocks start wrapped on a phone (T3's `readInitialWordWrapSetting`, from the viewport here),
 * unless the device's "Code wrapping" setting (Settings → Display) says wrap or scroll for every block.
 */
function readInitialWordWrapSetting(): boolean {
  let phone = false;
  try {
    phone =
      typeof window !== "undefined" && window.matchMedia?.("(max-width: 639px)").matches === true;
  } catch {
    phone = false;
  }
  return codeStartsWrapped(getTextPrefs().codeWrap, phone);
}

/** The bordered frame a code block sits in: a header with `title` (or the language) and `actions`. */
export function MarkdownCodeBlockFrame({
  language,
  title,
  wrapped = false,
  actions,
  children,
}: {
  language: string;
  title?: ReactNode;
  wrapped?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="chat-markdown-codeblock my-[0.65rem] overflow-hidden rounded-lg border border-border/70 bg-code leading-snug"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div
        className="chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none"
        data-thread-find-ignore=""
      >
        <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-2xs">
          <span className="truncate">{title ?? language}</span>
        </span>
        {actions}
      </div>
      {children}
    </div>
  );
}

export function MarkdownCodeBlock({
  node,
  children,
  className,
  source,
  ...props
}: MarkdownCodeBlockProps) {
  const [wrapped, setWrapped] = useState(readInitialWordWrapSetting);
  const codeElement = codeElementOf(node);
  const fallback = codeElement ? null : extractCodeBlock(children);
  const code = (codeElement ? hastPlainText(codeElement) : (fallback?.code ?? "")).replace(
    /\n$/,
    "",
  );
  const language = extractFenceLanguage(
    codeElement ? classNameText(codeElement.properties?.className) : fallback?.className,
  );
  const fenceTitle = extractFenceTitle(extractPreCodeMeta(node));
  // Without the document there is nothing to slice, so a block is taken as finished; while
  // streaming, an unterminated fence keeps its plain text until the closer arrives.
  const closed =
    source === undefined || node?.position?.start === undefined
      ? true
      : isClosedCodeFence(node, source, code);
  const highlightedHtml = useHighlightedHtml(code, language, closed && code.length > 0);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";

  const block = (
    <MarkdownCodeBlockFrame
      language={language}
      title={fenceTitle ?? language}
      wrapped={wrapped}
      actions={
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Code block actions">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant={wrapped ? "secondary" : "ghost-muted"}
                  size="icon-xs"
                  aria-pressed={wrapped}
                  onClick={() => setWrapped((value) => !value)}
                  aria-label={wrapLabel}
                />
              }
            >
              <WrapTextIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
          </Tooltip>
          <MessageCopyButton text={code} label="Copy code" size="icon-xs" variant="ghost" />
        </span>
      }
    >
      <pre
        {...props}
        className={cn(className, wrapped && "whitespace-pre-wrap wrap-anywhere")}
        data-highlighted={highlightedHtml !== null ? "" : undefined}
      >
        {highlightedHtml !== null ? (
          // highlight.js's own escaped markup; the raw `code` string is what Copy hands over.
          <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
        ) : (
          <code>{code}</code>
        )}
      </pre>
    </MarkdownCodeBlockFrame>
  );

  if (language === "mermaid") {
    return (
      <MarkdownMermaidCodeBlock code={code} fenceTitle={fenceTitle}>
        {block}
      </MarkdownMermaidCodeBlock>
    );
  }

  return block;
}
