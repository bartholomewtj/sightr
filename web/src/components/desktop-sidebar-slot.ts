export type DesktopSidebarSlot = "spaces" | "files" | "traces";

export const FILES_FIND_ID = "sightr-files-find";
export const FILES_TREE_ID = "sightr-files-tree";

/** Unscoped Traces destination (`/traces` or `/traces/:space/:repo` without `?pane=`). */
export function isTracesDest(pathname: string, search = ""): boolean {
  return pathname === "/traces" || (pathname.startsWith("/traces/") && !new URLSearchParams(search).has("pane"));
}

/** Selects the sidebar's middle content without coupling it to a particular route component. */
export function sidebarSlot(pathname: string, search = ""): DesktopSidebarSlot {
  if (pathname === "/files" || pathname.startsWith("/files/")) return "files";
  if (isTracesDest(pathname, search)) return "traces";
  return "spaces";
}

export function filesRelFromPath(pathname: string): string {
  if (!pathname.startsWith("/files/")) return "";
  return pathname.slice("/files/".length).split("/").filter(Boolean).map(decodeURIComponent).join("/");
}

/** The repo segment of `/traces/:spaceId/:repo`, or undefined on the Traces landing. */
export function tracesRepoFromPath(pathname: string): string | undefined {
  const parts = pathname.split("/");
  if (parts[1] !== "traces" || !parts[2] || !parts[3]) return undefined;
  return decodeURIComponent(parts[3]);
}
