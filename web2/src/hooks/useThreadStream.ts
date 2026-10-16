import { useEffect } from "react";

import { threadStream } from "@/stream/thread-stream";

/** Keeps the page's one thread stream on `threadId` while mounted (switching closes the old one first). */
export function useThreadStream(threadId: string): void {
  useEffect(() => {
    const stream = threadStream();
    stream.open(threadId);
    return () => {
      if (stream.threadId === threadId) stream.close();
    };
  }, [threadId]);
}
