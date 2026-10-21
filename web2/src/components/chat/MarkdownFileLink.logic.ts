// Adapted from T3 Code apps/web/src/components/chat/MarkdownFileLink.logic.ts @ 688ee52f0e8f (MIT, see THIRD_PARTY.md).
// The logic file's helpers as upstream. Folded in from the same commit, because Sightr has no
// `apps/web/src/markdown-links.ts`: `MarkdownFileLinkMeta`, `resolveMarkdownFileLinkMeta` and
// `shouldOpenMarkdownFileLinkInBrowserByDefault` (from that file), and a private copy of
// `formatWorkspaceRelativePath` (from `apps/web/src/filePathDisplay.ts`) for `displayPath`.
// Left out, for modules Sightr does not have: `canUseMarkdownFileShellActions` (T3's `EnvironmentId`
// and `RemoteOpenMode`) and `shouldOpenMarkdownFileLinkInEditor` (`terminal-links`).
import {
  fileBasename,
  isAbsolutePath,
  isWindowsAbsolutePath,
  stripSlashPrefixedWindowsDrive,
  workspaceRelativeFilePath,
} from "../../t3/shared/path.ts";
import { formatFilePathPosition, splitFilePathPosition } from "../../t3/shared/fileLinks.ts";
import {
  parseMarkdownFileLink,
  resolveMarkdownFileLinkTarget,
} from "../../t3/shared/markdownLinks.ts";

export interface MarkdownFileLinkMeta {
  filePath: string;
  workspaceLookupPath: string | null;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd, baseDir);
  if (!targetPath) return null;
  const source = href ? parseMarkdownFileLink(href) : null;
  return {
    ...buildFileLinkMetaFromTarget(targetPath, cwd),
    workspaceLookupPath:
      source !== null &&
      !isAbsolutePath(source.path) &&
      baseDir !== undefined &&
      workspaceRelativeFilePath(baseDir, cwd) === "."
        ? source.path
        : null,
  };
}

function buildFileLinkMetaFromTarget(targetPath: string, cwd?: string) {
  const { path, line, column } = splitFilePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function stripRelativePrefixes(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

/** How a path reads under its workspace root: `project/src/main.ts`, with any `:line` kept. */
export function formatWorkspaceRelativePath(
  pathWithPosition: string,
  workspaceRoot: string | undefined,
): string {
  const position = splitFilePathPosition(pathWithPosition);
  const normalizedPath = stripSlashPrefixedWindowsDrive(normalizePathSeparators(position.path));

  let displayPath = normalizedPath;
  if (workspaceRoot) {
    const normalizedWorkspaceRoot = stripSlashPrefixedWindowsDrive(
      normalizePathSeparators(trimTrailingSeparators(workspaceRoot)),
    );
    const workspaceLabel = fileBasename(normalizedWorkspaceRoot);
    const caseInsensitive = isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(workspaceRoot));
    const pathForCompare = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
    const workspaceForCompare = caseInsensitive
      ? normalizedWorkspaceRoot.toLowerCase()
      : normalizedWorkspaceRoot;
    const workspaceWithSeparator = `${workspaceForCompare}/`;
    const workspaceLabelWithSeparator = `${caseInsensitive ? workspaceLabel.toLowerCase() : workspaceLabel}/`;

    if (pathForCompare === workspaceForCompare) {
      displayPath = workspaceLabel;
    } else if (pathForCompare.startsWith(workspaceWithSeparator)) {
      const relativeSuffix = normalizedPath.slice(normalizedWorkspaceRoot.length + 1);
      displayPath = `${workspaceLabel}/${relativeSuffix}`;
    } else if (!normalizedPath.startsWith("/")) {
      const relativePath = stripRelativePrefixes(normalizedPath);
      displayPath = pathForCompare.startsWith(workspaceLabelWithSeparator)
        ? normalizedPath
        : `${workspaceLabel}/${relativePath}`;
    }
  }

  return formatFilePathPosition({ ...position, path: displayPath });
}

export function shouldOpenMarkdownFileLinkInBrowserByDefault(path: string): boolean {
  return /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");
}

export function hasMarkdownFilePrimaryAction(input: {
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
  canOpenMedia?: boolean;
}): boolean {
  return (
    input.canOpenInEditor ||
    input.canOpenInBrowser ||
    input.canOpenInPanel ||
    input.canOpenMedia === true
  );
}

export function markdownFileCopyMenuItems({
  targetPath,
  workspaceRelativePath,
}: Pick<MarkdownFileLinkMeta, "targetPath" | "workspaceRelativePath">) {
  const items = [
    { id: "copy-full", label: "Copy full path", value: targetPath, title: "Full path" },
  ];
  if (workspaceRelativePath !== null) {
    const position = targetPath.slice(splitFilePathPosition(targetPath).path.length);
    items.unshift({
      id: "copy-relative",
      label: "Copy relative path",
      value: `${workspaceRelativePath}${position}`,
      title: "Relative path",
    });
  }
  return items;
}

export function shouldUseMarkdownFileBrowserPrimaryAction(input: {
  iconPath: string;
  canOpenInEditor: boolean;
  canOpenInBrowser: boolean;
  canOpenInPanel: boolean;
}): boolean {
  return (
    input.canOpenInBrowser &&
    (shouldOpenMarkdownFileLinkInBrowserByDefault(input.iconPath) ||
      (!input.canOpenInEditor && !input.canOpenInPanel))
  );
}
