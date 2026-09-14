import { useEffect, useRef } from "react";
import * as api from "@/lib/api";
import { setStatus } from "@/lib/status";

export interface DropUploadArgs {
  paneId: string;
  enabled: boolean;
  onPath: (path: string) => void;
  uploadImage?: (file: File) => Promise<string | null>;
}

/** Protect the desktop page from navigation drops and upload the first dropped image. */
export function useDropUpload({ paneId, enabled, onPath, uploadImage }: DropUploadArgs): void {
  const onPathRef = useRef(onPath);
  const uploadImageRef = useRef(uploadImage);
  onPathRef.current = onPath;
  uploadImageRef.current = uploadImage;

  useEffect(() => {
    if (!enabled) return;
    const onDragOver = (event: DragEvent) => event.preventDefault();
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const file = Array.from(files).find((candidate) => candidate.type.startsWith("image/"));
      if (!file) {
        setStatus("Only images can be dropped", "error");
        return;
      }
      const upload = uploadImageRef.current ?? (async (image: File) => {
        const result = await api.uploadImage(paneId, image);
        if (!result.ok) {
          setStatus(result.error ?? "Image upload failed.", "error");
          return null;
        }
        return result.path;
      });
      void upload(file).then((path) => {
        if (!path) return;
        setStatus("Image uploaded — click Type path to insert it", "success");
        onPathRef.current(path);
      }).catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), "error"));
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [enabled, paneId]);
}
