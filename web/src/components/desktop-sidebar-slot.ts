export type DesktopSidebarSlot = "spaces" | "files";

export const FILES_FIND_ID = "sightr-files-find";
export const FILES_TREE_ID = "sightr-files-tree";

/** Selects the sidebar's middle content without coupling it to a particular route component. */
export function sidebarSlot(pathname: string): DesktopSidebarSlot {
  if (pathname === "/files" || pathname.startsWith("/files/")) return "files";
  return "spaces";
}

export function filesRelFromPath(pathname: string): string {
  if (!pathname.startsWith("/files/")) return "";
  return pathname.slice("/files/".length).split("/").filter(Boolean).map(decodeURIComponent).join("/");
}
