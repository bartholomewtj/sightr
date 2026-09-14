// Route path helpers. Pane ids contain a colon (e.g. "wE:p2"), so they must be URL-encoded in the
// path; React Router decodes them back in useParams.

export function panePath(paneId: string): string {
  return `/pane/${encodeURIComponent(paneId)}`;
}

/** The Traces list (every SSSF repo the bridge found, across spaces) — the bottom bar's Traces tab. */
export function tracesPath(): string {
  return `/traces`;
}

/** One repo's trace visualiser, full screen. The workspace picks the db on the bridge; the repo is a
 *  name from that workspace's `sssf.repos` (never a path). `pane` scopes the screen to the runs that
 *  pane launched (its Traces button; back then returns to the pane), `adw` opens on one run. */
export function tracePath(
  spaceId: string,
  repo: string,
  scope: { pane?: string; adw?: string } = {},
): string {
  const q = new URLSearchParams();
  if (scope.pane) q.set("pane", scope.pane);
  if (scope.adw) q.set("adw", scope.adw);
  const search = q.toString();
  return `/traces/${encodeURIComponent(spaceId)}/${encodeURIComponent(repo)}${search ? `?${search}` : ""}`;
}

/** The home path (Spaces tree). */
export function homePath(): string {
  return "/";
}

/** Build the same-origin download endpoint for a relative work-root path. */
export function downloadFileUrl(rel: string): string {
  return `/api/files/download?path=${encodeURIComponent(rel)}`;
}

/** The Files browser destination. */
export function filesPath(): string {
  return `/files`;
}
export function filePath(rel: string): string {
  const encoded = rel.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/files/${encoded}`;
}

export function settingsPath(): string {
  return `/settings`;
}
