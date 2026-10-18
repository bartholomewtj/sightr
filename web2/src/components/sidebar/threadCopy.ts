// "Copy thread id" and "Copy folder path": the palette's thread actions and the sidebar row menu call
// these two functions. The clipboard write falls back to execCommand (`copyText`). The folder path is the
// Files-root-relative one the bridge answers with: the absolute working folder never reaches the client
// (ADR 0026), so what is copied is what the Files tab shows.
import { copyText } from "@/components/chat/MessageCopyButton";
import { showToast } from "@/components/toast";
import { fetchPaneFolder } from "@/lib/api";

export type CopyOutcome = "copied" | "failed" | "no-folder";

export async function copyThreadId(threadId: string): Promise<CopyOutcome> {
  const ok = await copyText(threadId);
  showToast(ok ? "Thread id copied" : "Couldn't copy the thread id", ok ? "info" : "error");
  return ok ? "copied" : "failed";
}

/** What to copy for a Files-root-relative folder: "." for the root itself. */
export function folderPathText(rel: string): string {
  return rel === "" ? "." : rel;
}

/**
 * Write a clipboard value that is not known yet. Safari only allows the write inside the tap, so the
 * promise goes to the clipboard at once (`ClipboardItem`) instead of after the fetch.
 */
async function copyLater(text: Promise<string | null>): Promise<boolean> {
  const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clip?.write && typeof ClipboardItem !== "undefined") {
    try {
      const blob = text.then((t) => {
        // Nothing to copy: reject, so the clipboard keeps what it had.
        if (t === null) throw new Error("nothing to copy");
        return new Blob([t], { type: "text/plain" });
      });
      await clip.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    } catch {
      /* fall through to the plain write */
    }
  }
  const value = await text;
  return value === null ? false : copyText(value);
}

export async function copyThreadFolderPath(paneId: string): Promise<CopyOutcome> {
  const lookup = fetchPaneFolder(paneId)
    .then((r) => (r.path === null ? null : folderPathText(r.path)))
    .catch(() => null);
  const ok = await copyLater(lookup);
  if (ok) {
    showToast("Folder path copied");
    return "copied";
  }
  const found = await lookup;
  if (found === null) {
    showToast("This folder isn't under the Files root", "error");
    return "no-folder";
  }
  showToast("Couldn't copy the folder path", "error");
  return "failed";
}
