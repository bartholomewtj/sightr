// Route path helpers. Pane ids contain a colon (e.g. "wE:p2"), so they must be URL-encoded in the
// path; React Router decodes them back in useParams.

export function panePath(paneId: string): string {
  return `/pane/${encodeURIComponent(paneId)}`;
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
