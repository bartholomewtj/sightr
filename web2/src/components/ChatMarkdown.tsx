// Adapted from T3 Code apps/web/src/components/ChatMarkdown.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Same structure: `react-markdown` + `remark-gfm` (+ `remark-breaks` for `lineBreaks`), a stable
// component map (headings with an aria-level offset, code blocks in a titled frame with Copy, tables in
// a scroll container), the `.chat-markdown` class the stylesheet styles.
// Left out to keep the bundle small (T11): Shiki highlighting, Mermaid diagrams, raw-HTML rendering
// (rehype-raw + rehype-sanitize), workspace file links and file chips, images and video, citations,
// skill chips, Codex artifact directives, GitHub alerts, task-list toggling, incremental parsing.
// Sightr rules:
// - No HTML injection: raw HTML in the text is shown as text (the `html` nodes become `text` nodes).
// - Only `http(s)://` and `mailto:` links are links (web/src/lib/links.ts keeps to explicit schemes);
//   they open in a new tab with `rel="noopener noreferrer"`. Anything else renders as its text.
// - Images are not loaded; an image becomes a link to its URL (or its alt text).
// - Code blocks keep T3's "Wrap lines" toggle (`data-wrap`); it starts on below the `sm` breakpoint
//   (T3 starts from its word-wrap setting), so a phone reads a long line without sideways scrolling;
//   Settings → Display → Code wrapping (state/text-prefs.ts) can force wrap or scroll for every block.
//   The header is `data-thread-find-ignore`, as upstream's.
// - Workspace file links, Sightr's way: inside a thread (OpenFileThreadContext), inline code that reads
//   as a file path is a button that opens it in the Files tab (right-panel/OpenFileLink.tsx).
import { memo, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { WrapTextIcon } from "lucide-react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { cn } from "~/lib/utils";
import { codeStartsWrapped, getTextPrefs } from "@/state/text-prefs";

import { MessageCopyButton } from "./chat/MessageCopyButton";
import { looksLikeFilePath, OpenFileLink, useOpenFileThread } from "./right-panel/OpenFileLink";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface ChatMarkdownProps {
  text: string;
  className?: string;
  lineBreaks?: boolean;
  isStreaming?: boolean;
  headingLevelOffset?: number;
}

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** remark plugin: raw HTML is shown as typed, never parsed (Sightr's no-injection rule). */
function remarkHtmlAsText() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (node.type === "html") node.type = "text";
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

const REMARK_PLUGINS = [remarkGfm, remarkHtmlAsText];
const REMARK_PLUGINS_WITH_BREAKS = [remarkGfm, remarkBreaks, remarkHtmlAsText];

const SAFE_LINK = /^(?:https?:\/\/[a-z0-9]|mailto:)/i;

export function isSafeMarkdownHref(href: string | undefined): href is string {
  return typeof href === "string" && SAFE_LINK.test(href.trim());
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;

function extractFenceLanguage(className: unknown): string {
  const value = Array.isArray(className) ? className.join(" ") : typeof className === "string" ? className : "";
  return CODE_FENCE_LANGUAGE_REGEX.exec(value)?.[1] ?? "text";
}

/**
 * Code blocks start wrapped on a phone (T3's `readInitialWordWrapSetting`, from the viewport here), unless
 * the device's "Code wrapping" setting (Settings → Display) says wrap or scroll for every block.
 */
function readInitialWordWrapSetting(): boolean {
  let phone = false;
  try {
    phone = typeof window !== "undefined" && window.matchMedia?.("(max-width: 639px)").matches === true;
  } catch {
    phone = false;
  }
  return codeStartsWrapped(getTextPrefs().codeWrap, phone);
}

export function MarkdownCodeBlockFrame({
  language,
  wrapped = false,
  actions,
  children,
}: {
  language: string;
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
          <span className="truncate">{language}</span>
        </span>
        {actions}
      </div>
      {children}
    </div>
  );
}

function MarkdownCodeBlock({ node, children: _children, className, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const [wrapped, setWrapped] = useState(readInitialWordWrapSetting);
  const codeNode = (node as HastNode | undefined)?.children?.find(
    (child) => child.type === "element" && child.tagName === "code",
  );
  const code = hastText(codeNode).replace(/\n$/, "");
  const language = extractFenceLanguage(codeNode?.properties?.className);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  return (
    <MarkdownCodeBlockFrame
      language={language}
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
      <pre {...props} className={cn(className, wrapped && "whitespace-pre-wrap wrap-anywhere")}>
        <code>{code}</code>
      </pre>
    </MarkdownCodeBlockFrame>
  );
}

function headingRenderer(level: 1 | 2 | 3 | 4 | 5 | 6, offset: number) {
  const Tag = `h${level}` as const;
  return function MarkdownHeading({ node: _node, ...props }: ComponentProps<typeof Tag> & ExtraProps) {
    return <Tag {...props} aria-level={offset > 0 ? Math.min(level + offset, 6) : undefined} />;
  };
}

function MarkdownLink({ node: _node, href, children, ...props }: ComponentProps<"a"> & ExtraProps) {
  if (!isSafeMarkdownHref(href)) return <span>{children}</span>;
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function MarkdownImage({ node: _node, src, alt }: ComponentProps<"img"> & ExtraProps) {
  const label = alt?.trim() || (typeof src === "string" ? src : "image");
  if (typeof src === "string" && isSafeMarkdownHref(src)) {
    return (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  }
  return <span>{label}</span>;
}

/**
 * Inline code (a block's `<code>` is drawn by MarkdownCodeBlock). Inside a thread, a path an agent
 * printed (`web2/src/x.ts:12`, `notes.md`) opens in the Files tab; the bridge refuses what it can't open.
 */
function MarkdownInlineCode({ node: _node, children, ...props }: ComponentProps<"code"> & ExtraProps) {
  const threadId = useOpenFileThread();
  const text = typeof children === "string" ? children : null;
  if (threadId && text !== null && looksLikeFilePath(text)) {
    return (
      <code {...props}>
        <OpenFileLink threadId={threadId} path={text} className="no-underline hover:underline">
          {text}
        </OpenFileLink>
      </code>
    );
  }
  return <code {...props}>{children}</code>;
}

function MarkdownTable({ node: _node, ...props }: ComponentProps<"table"> & ExtraProps) {
  return (
    <div className="chat-markdown-table-container max-w-full overflow-x-auto">
      <table {...props} />
    </div>
  );
}

const componentsByOffset = new Map<number, Components>();

function chatMarkdownComponents(offset: number): Components {
  let components = componentsByOffset.get(offset);
  if (!components) {
    components = {
      h1: headingRenderer(1, offset),
      h2: headingRenderer(2, offset),
      h3: headingRenderer(3, offset),
      h4: headingRenderer(4, offset),
      h5: headingRenderer(5, offset),
      h6: headingRenderer(6, offset),
      a: MarkdownLink,
      img: MarkdownImage,
      pre: MarkdownCodeBlock,
      code: MarkdownInlineCode,
      table: MarkdownTable,
    };
    componentsByOffset.set(offset, components);
  }
  return components;
}

function ChatMarkdown({ text, className, lineBreaks = false, isStreaming = false, headingLevelOffset = 0 }: ChatMarkdownProps) {
  const components = useMemo(() => chatMarkdownComponents(headingLevelOffset), [headingLevelOffset]);
  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere] [word-break:break-word]",
        className,
      )}
      data-streaming={isStreaming ? "" : undefined}
    >
      <ReactMarkdown
        remarkPlugins={lineBreaks ? REMARK_PLUGINS_WITH_BREAKS : REMARK_PLUGINS}
        skipHtml={false}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
