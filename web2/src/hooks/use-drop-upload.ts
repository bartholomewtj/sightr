// Copied from web/src/hooks/use-drop-upload.ts and adapted to threads (T12): a drop anywhere on the
// page (desktop) hands every dropped file to the composer, which uploads them as attachment chips on
// the thread's pane. The page itself never navigates to a dropped file.
import { useEffect, useRef } from "react";

export interface DropUploadArgs {
  enabled: boolean;
  onFiles: (files: File[]) => void;
}

/** Protect the page from navigation drops and pass dropped files to `onFiles`. */
export function useDropUpload({ enabled, onFiles }: DropUploadArgs): void {
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    if (!enabled) return;
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      onFilesRef.current(Array.from(files));
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [enabled]);
}
