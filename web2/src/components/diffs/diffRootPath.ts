// Sightr code (T27). A repo's root as a Files rel path, so a changed file (a repo-relative path) can open in
// the Files tab. The Git tab's status carries it (`rootPath`); the Diff panel asks the first time a file is
// opened in Files, and keeps the answer by Files folder for the life of the page.
import { fetchFolderGit } from "@/lib/api";

const rootPathByFolder = new Map<string, string>();

/** The repo root's Files path (`""` is the Files root), or undefined when the bridge could not say. */
export async function repoRootPath(folderPath: string, paneId: string | null): Promise<string | undefined> {
  const known = rootPathByFolder.get(folderPath);
  if (known !== undefined) return known;
  try {
    const res = await fetchFolderGit(folderPath, paneId ? [paneId] : []);
    if (res.available && res.rootPath !== undefined) {
      rootPathByFolder.set(folderPath, res.rootPath);
      return res.rootPath;
    }
  } catch {
    /* the caller says so */
  }
  return undefined;
}

/** Test helper. */
export function __resetDiffRootPaths(): void {
  rootPathByFolder.clear();
}
