// Sightr's own component, same job and name as T3 Code's
// apps/web/src/components/chat/MarkdownFileLink.tsx @ 688ee52f0e8f (MIT, see THIRD_PARTY.md).
// T3's own file is a context-menu chip over its local API, toasts and editor actions; Sightr has one
// Files tab, so the chip is T13's `OpenFileLink` (a button that opens the path in Files, the sheet on a
// phone). A `cwd` resolves an absolute or `file://` href through the ported T3 logic; a relative path
// has no root here, so it goes to the bridge as-is and `looksLikeFilePath` decides (the same test the
// inline-code path link uses). A non-file `href` stays plain text.
import type { ReactNode } from "react";

import { looksLikeFilePath, OpenFileLink } from "../right-panel/OpenFileLink";
import { resolveMarkdownFileLinkMeta } from "./MarkdownFileLink.logic";

interface MarkdownFileLinkProps {
  threadId: string;
  href: string;
  cwd?: string;
  children?: ReactNode;
}

/** `file://` and a leading `./` are href syntax, not path text. */
function stripHrefPrefix(href: string): string {
  return href.replace(/^file:\/\//i, "").replace(/^\.\//, "");
}

/** A Windows drive path the ported relative-path test does not read as a plain file name. */
function isWindowsDrivePath(href: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(href);
}

/**
 * Is this `href` a workspace file rather than a URL or an anchor? Used by the host to choose a file
 * chip over a plain anchor. `cwd` is optional; a relative path is accepted on `looksLikeFilePath`.
 */
export function isMarkdownFileHref(href: string | undefined, cwd?: string): boolean {
  if (typeof href !== "string" || href.trim() === "") return false;
  const value = href.trim();
  if (resolveMarkdownFileLinkMeta(value, cwd) !== null) return true;
  const stripped = stripHrefPrefix(value);
  return isWindowsDrivePath(stripped) || looksLikeFilePath(stripped);
}

/**
 * A markdown link to a workspace path — relative, absolute, or a `file://` URL, with an optional
 * `:line(:col)` — as a chip that opens it in the Files tab. The path is never fetched by the browser;
 * the bridge decides whether the Files root can show it. When the href is not a file (a URL, an
 * anchor), the label is rendered as text.
 */
export function MarkdownFileLink({ threadId, href, cwd, children }: MarkdownFileLinkProps) {
  const meta = resolveMarkdownFileLinkMeta(href, cwd);
  if (meta) {
    // `displayPath` already carries the `:line(:col)` read from the href (formatWorkspaceRelativePath
    // keeps the position), so it is the label as-is.
    return (
      <OpenFileLink threadId={threadId} path={meta.targetPath} className="font-mono">
        {children ?? meta.displayPath}
      </OpenFileLink>
    );
  }
  const stripped = stripHrefPrefix(href);
  if (!isWindowsDrivePath(stripped) && !looksLikeFilePath(stripped)) return <span>{children}</span>;
  return (
    <OpenFileLink threadId={threadId} path={stripped} className="font-mono">
      {children}
    </OpenFileLink>
  );
}
