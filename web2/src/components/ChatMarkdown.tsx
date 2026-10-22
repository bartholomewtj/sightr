// Adapted from T3 Code apps/web/src/components/ChatMarkdown.tsx @ 688ee52f0e8f (MIT, see
// THIRD_PARTY.md). Same structure as T11's port: `react-markdown` + `remark-gfm` (+ `remark-breaks`
// for `lineBreaks`), a stable component map (headings with an aria-level offset, code blocks in a
// titled frame with Copy, tables in a scroll container), the `.chat-markdown` class the stylesheet
// styles.
// T35 adds the pieces T11 left out and T3 has since built as small modules: `remarkGithubAlerts` and
// `remarkNormalizeListItemIndentation` (pure, ported), `remark-math` + `rehype-katex` for formulas,
// and the `chat/Markdown*` components for highlighted code, Mermaid diagrams, `<details>` and table
// copy/expand. T36 adds inline media and markdown file links.
// Sightr rules:
// - No HTML injection: raw HTML in the text is shown as text (the `html` nodes become `text` nodes),
//   and the only HTML-shaped output is KaTeX's own, added at the rehype stage after that pass. No
//   `rehype-raw` / `rehype-sanitize`.
// - Only `http(s)://` and `mailto:` links are links (web/src/lib/links.ts keeps to explicit schemes);
//   they open in a new tab with `rel="noopener noreferrer"`. Anything else renders as its text, except
//   a workspace path inside a thread, which becomes a file chip (T36).
// - Media loads only `http(s)` and `data:image` sources (T36); anything else stays a link or its alt.
// - Code blocks keep T3's "Wrap lines" toggle (`data-wrap`); it starts on below the `sm` breakpoint,
//   and Settings → Display → Code wrapping (state/text-prefs.ts) can force wrap or scroll. The header
//   is `data-thread-find-ignore`, as upstream's.
// - Workspace file links, Sightr's way: inside a thread (OpenFileThreadContext), inline code that reads
//   as a file path is a button that opens it in the Files tab, and a markdown link to one is a chip.
import { createContext, memo, Suspense, useContext, useMemo, type ComponentProps } from "react";
import type { PluggableList } from "unified";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { cn } from "~/lib/utils";
import { suspendOn } from "~/lib/suspend";
import { remarkGithubAlerts } from "~/t3/shared/markdownGithubAlerts";
import { remarkNormalizeListItemIndentation } from "~/t3/shared/markdownListIndentation";

import { MarkdownCodeBlock } from "./chat/MarkdownCodeBlock";
import { isMarkdownFileHref, MarkdownFileLink } from "./chat/MarkdownFileLink";
import { MarkdownMedia } from "./chat/MarkdownMedia";
import { MarkdownTable } from "./chat/MarkdownTable";
import { looksLikeFilePath, OpenFileLink, useOpenFileThread } from "./right-panel/OpenFileLink";

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

/**
 * Math is parsed only when the text could hold a formula — a `$`, a `\(`/`\[` or a ` ```math ` fence.
 * `remark-math` then keeps a formula's authored source in the node, and `rehype-katex` typesets it.
 */
const MATH_HINT = /\$|\\\(|\\\[|`{3,}\s*math\b/;

const REMARK_BASE = [remarkGfm, remarkGithubAlerts, remarkNormalizeListItemIndentation, remarkHtmlAsText];
const REMARK_BASE_BREAKS = [remarkGfm, remarkBreaks, remarkGithubAlerts, remarkNormalizeListItemIndentation, remarkHtmlAsText];

/**
 * KaTeX is ~266 KB raw and only a message that holds a formula needs it, so `rehype-katex` is loaded
 * on first use instead of being imported into the thread route's chunk (spec 27). A formula KaTeX
 * cannot parse (`throwOnError: false`) keeps its raw TeX rather than breaking the reply.
 */
let rehypeMathLoad: Promise<PluggableList> | null = null;
function loadRehypeMath(): Promise<PluggableList> {
  if (!rehypeMathLoad) {
    const load = import("rehype-katex").then(
      (m) => [[m.default, { throwOnError: false, strict: false }]] as PluggableList,
    );
    // A rejected module stays rejected in the ESM cache; forget it so a remount tries again.
    void load.catch(() => {
      if (rehypeMathLoad === load) rehypeMathLoad = null;
    });
    rehypeMathLoad = load;
  }
  return rehypeMathLoad;
}

/** No rehype plugins: the raw-TeX fallback while KaTeX loads, and the path for text without math. */
const NO_REHYPE: PluggableList = [];

function remarkPluginsFor(lineBreaks: boolean, math: boolean): PluggableList {
  const base = lineBreaks ? REMARK_BASE_BREAKS : REMARK_BASE;
  return math ? [[remarkMath, { singleDollarTextMath: true }], ...base] : base;
}

const SAFE_LINK = /^(?:https?:\/\/[a-z0-9]|mailto:)/i;

export function isSafeMarkdownHref(href: string | undefined): href is string {
  return typeof href === "string" && SAFE_LINK.test(href.trim());
}

/** A source the browser may load for an inline image or video (T36). `data:image/` is allowed; nothing else is. */
const SAFE_MEDIA_SRC = /^(?:https?:\/\/|data:image\/)/i;

/** The document text, so a code block can tell a finished fence from one still streaming (T35). */
const MarkdownTextContext = createContext<string | undefined>(undefined);

function headingRenderer(level: 1 | 2 | 3 | 4 | 5 | 6, offset: number) {
  const Tag = `h${level}` as const;
  return function MarkdownHeading({ node: _node, ...props }: ComponentProps<typeof Tag> & ExtraProps) {
    return <Tag {...props} aria-level={offset > 0 ? Math.min(level + offset, 6) : undefined} />;
  };
}

/**
 * Inside a thread, a link to a workspace path (`[main.go](web2/src/main.go)`, a `file://` URL, an
 * absolute path) is a file chip that opens it in the Files tab (T36). Everything else keeps T11's rule.
 */
function MarkdownAnchor({ node: _node, href, children, ...props }: ComponentProps<"a"> & ExtraProps) {
  const threadId = useOpenFileThread();
  if (threadId && isMarkdownFileHref(href)) {
    return (
      <MarkdownFileLink threadId={threadId} href={href as string}>
        {children}
      </MarkdownFileLink>
    );
  }
  if (!isSafeMarkdownHref(href)) return <span>{children}</span>;
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * An inline image or video the agent embedded (T36). A safe `http(s)`/`data:image` source renders as
 * media; a `file://`, relative or missing source keeps T11's behaviour (a link when it is safe, else
 * its alt text).
 */
function MarkdownImage({ node: _node, src, alt, title }: ComponentProps<"img"> & ExtraProps) {
  const value = typeof src === "string" ? src.trim() : "";
  if (SAFE_MEDIA_SRC.test(value)) return <MarkdownMedia src={value} alt={alt} title={title} />;
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
 * The `pre` renderer, handed the document so a streaming fence stays plain until its closer arrives.
 */
function MarkdownPre(props: ComponentProps<"pre"> & ExtraProps) {
  const source = useContext(MarkdownTextContext);
  return <MarkdownCodeBlock {...props} source={source} />;
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
      a: MarkdownAnchor,
      img: MarkdownImage,
      pre: MarkdownPre,
      code: MarkdownInlineCode,
      table: MarkdownTable,
    };
    componentsByOffset.set(offset, components);
  }
  return components;
}

interface MarkdownBodyProps extends ChatMarkdownProps {
  /** Parse `$…$` / `$$…$$` (and the other math forms) and typeset with KaTeX. */
  math: boolean;
  rehypePlugins: PluggableList;
}

function MarkdownBody({
  text,
  className,
  lineBreaks = false,
  isStreaming = false,
  headingLevelOffset = 0,
  math,
  rehypePlugins,
}: MarkdownBodyProps) {
  const components = useMemo(() => chatMarkdownComponents(headingLevelOffset), [headingLevelOffset]);
  const remarkPlugins = useMemo(() => remarkPluginsFor(lineBreaks, math), [lineBreaks, math]);
  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere] [word-break:break-word]",
        className,
      )}
      data-streaming={isStreaming ? "" : undefined}
    >
      <MarkdownTextContext value={text}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          skipHtml={false}
          components={components}
        >
          {text}
        </ReactMarkdown>
      </MarkdownTextContext>
    </div>
  );
}

/** The math path: suspends until KaTeX has loaded, then typesets. The caller owns the fallback. */
function MathMarkdown(props: ChatMarkdownProps) {
  const rehypePlugins = suspendOn(loadRehypeMath());
  return <MarkdownBody {...props} math rehypePlugins={rehypePlugins} />;
}

function ChatMarkdown(props: ChatMarkdownProps) {
  // The common case: no formula in the text, so KaTeX is neither loaded nor suspended on. While a
  // formula's KaTeX loads, the fallback is the same body without math, so the raw TeX shows rather
  // than a blank reply.
  if (!MATH_HINT.test(props.text)) return <MarkdownBody {...props} math={false} rehypePlugins={NO_REHYPE} />;
  return (
    <Suspense fallback={<MarkdownBody {...props} math={false} rehypePlugins={NO_REHYPE} />}>
      <MathMarkdown {...props} />
    </Suspense>
  );
}

export default memo(ChatMarkdown);
