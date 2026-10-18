/**
 * Images on timeline items (T3's user-message image grid, apps/web/src/components/chat/MessagesTimeline.tsx
 * @ db5919d87, pattern): a user's pasted or uploaded images in their bubble, and a tool's output images
 * (a Read of a PNG, a screenshot) in its opened row. The bytes come from the bridge's attachment route
 * (`v2AttachmentPath`), same origin; nothing is inlined in the thread stream.
 *
 * Phone: every tile reserves its box (`aspect-[4/3]`) before the image loads, so nothing shifts; images
 * load lazily; a tile is a 44 px+ button that opens T3's ExpandedImageDialog (swipe to page); an image
 * the bridge can no longer find (an upload swept after 48 h, a log removed) shows a labelled
 * placeholder instead of a broken image. The grid never exceeds its lane.
 */
import { v2AttachmentPath, type ChatAttachment } from "@shared/v2/contracts";
import { ImageOffIcon, PaperclipIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";

import { ExpandedImageDialog, type ExpandedImagePreview } from "./ExpandedImageDialog";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** Whether an attachment is an image the timeline previews. A dispatch item's chip has only a path. */
export function isImageAttachment(attachment: ChatAttachment): boolean {
  if (attachment.type === "image") return true;
  if (attachment.type === "file") return false;
  return attachment.mimeType?.startsWith("image/") === true || IMAGE_EXT.test(attachment.path) || IMAGE_EXT.test(attachment.name);
}

export interface TimelineImage {
  src: string;
  name: string;
  key: string;
}

/** The item's images with their route URLs (the index is the attachment's place in the item). */
export function timelineImages(threadId: string, itemId: string, attachments: readonly ChatAttachment[]): TimelineImage[] {
  return attachments.flatMap((attachment, index) =>
    isImageAttachment(attachment)
      ? [{ src: v2AttachmentPath(threadId, itemId, index), name: attachment.name || `Image ${index + 1}`, key: attachment.id ?? `${index}:${attachment.path}` }]
      : [],
  );
}

const ImageTile = memo(function ImageTile({ image, onOpen }: { image: TimelineImage; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div
        role="img"
        aria-label={`${image.name} (unavailable)`}
        data-attachment-state="failed"
        className="flex size-full flex-col items-center justify-center gap-1 px-2 text-center text-2xs text-muted-foreground"
      >
        <ImageOffIcon aria-hidden className="size-4 shrink-0" />
        <span className="line-clamp-2 wrap-anywhere">Image unavailable</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="block size-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-label={`Preview ${image.name}`}
      onClick={onOpen}
    >
      <img
        src={image.src}
        alt={image.name}
        loading="lazy"
        decoding="async"
        draggable={false}
        className="block size-full object-cover"
        onError={() => setFailed(true)}
      />
    </button>
  );
});

/**
 * An item's image tiles and file chips. `variant="message"` is T3's two-column grid inside a bubble;
 * `"tool"` a row of fixed tiles under a tool's call.
 */
export const TimelineAttachments = memo(function TimelineAttachments({
  threadId,
  itemId,
  attachments,
  variant,
  className,
}: {
  threadId: string;
  itemId: string;
  attachments: readonly ChatAttachment[];
  variant: "message" | "tool";
  className?: string;
}) {
  const [expanded, setExpanded] = useState<ExpandedImagePreview | null>(null);
  const images = timelineImages(threadId, itemId, attachments);
  const files = attachments.filter((a) => !isImageAttachment(a));
  if (images.length === 0 && files.length === 0) return null;
  const open = (index: number) => setExpanded({ images: images.map((i) => ({ src: i.src, name: i.name })), index });
  return (
    <div className={cn("min-w-0 space-y-2", className)} data-timeline-attachments={variant}>
      {images.length > 0 ? (
        <div
          className={cn(
            "grid gap-2",
            variant === "message" ? "max-w-[210px] grid-cols-2" : "max-w-full grid-cols-[repeat(auto-fill,minmax(6rem,8rem))]",
          )}
        >
          {images.map((image, index) => (
            <div key={image.key} className="aspect-[4/3] min-w-0 overflow-hidden rounded-lg border border-border/80 bg-background/70">
              <ImageTile image={image} onOpen={() => open(index)} />
            </div>
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {files.map((file, index) => (
            <span
              key={file.id ?? `${index}:${file.path}`}
              title={file.path || file.name}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background/60 px-1.5 py-0.5 text-xs"
            >
              <PaperclipIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{file.name}</span>
            </span>
          ))}
        </div>
      ) : null}
      {expanded ? <ExpandedImageDialog preview={expanded} onClose={() => setExpanded(null)} /> : null}
    </div>
  );
});
