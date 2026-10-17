// Adapted from T3 Code apps/web/src/components/chat/ExpandedImageDialog.tsx @ db5919d87daffd2d2db16e72602a586feb002adb (MIT, THIRD_PARTY.md).
// Images only: no video, asset URLs, SnapShot details, MediaActions or open-original link, and no
// `@effect/atom-react` host (the composer holds the open preview in its own state). Phone path: a
// horizontal swipe on an unzoomed image goes to the previous/next one; the close button is 44px on touch.
import { memo, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";

export interface ExpandedImageItem {
  src: string | null;
  name: string;
}

export interface ExpandedImagePreview {
  images: readonly ExpandedImageItem[];
  index: number;
}

/** T3's index wrap: JavaScript `%` keeps the sign of the dividend, and a negative index blanks the dialog. */
export function wrapExpandedImageIndex(index: number, count: number): number {
  return count > 0 ? ((index % count) + count) % count : 0;
}

/** A swipe this far sideways (and mostly sideways) changes the image. */
export const SWIPE_PX = 50;

/** -1 / 1 for a sideways swipe, null for a tap, a vertical move or a short one. */
export function swipeDirection(dx: number, dy: number): -1 | 1 | null {
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 2) return null;
  return dx > 0 ? -1 : 1;
}

const EXPANDED_MEDIA_STATE_CLASS_NAME =
  "flex aspect-auto h-48 min-h-0 w-[min(var(--media-width),32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white shadow-2xl";

function ExpandedMediaFailure({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className={EXPANDED_MEDIA_STATE_CLASS_NAME}>
      {children}
    </div>
  );
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
}: {
  preview: ExpandedImagePreview;
  onClose: () => void;
}) {
  const [imageOffset, setImageOffset] = useState(0);
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const zoomableImageRef = useRef<ZoomableImageHandle>(null);
  const [returnFocusTarget] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const swipeRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const imageCount = preview.images.length;
  const index = wrapExpandedImageIndex(preview.index + imageOffset, imageCount);
  const item = preview.images[index];

  const navigateImage = (direction: -1 | 1) => {
    setImageOffset((current) => current + direction);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (zoomableImageRef.current?.pan(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (preview.images.length <= 1) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      navigateImage(-1);
      return;
    }
    if (event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    navigateImage(1);
  };

  // Touch: a sideways swipe changes the image, unless the image is zoomed (its region scrolls then).
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || imageCount <= 1) return;
    const region = (event.target as HTMLElement).closest?.("[role=region]");
    if (region && region.scrollWidth > region.clientWidth) return;
    swipeRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    const direction = swipeDirection(event.clientX - start.x, event.clientY - start.y);
    if (direction !== null) navigateImage(direction);
  };

  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onEscape, { capture: true });
    return () => window.removeEventListener("keydown", onEscape, { capture: true });
  }, [onClose]);

  if (!item) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1 h-full max-h-[92vh] w-[92vw] max-w-[92vw] items-center justify-center overflow-visible [--media-width:92vw] [--media-height:min(86vh,calc(100vh-160px))] sm:[--media-width:calc(92vw-96px)]"
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          swipeRef.current = null;
        }}
        initialFocus={closeButtonRef}
        finalFocus={() => returnFocusTarget}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <DialogTitle className="sr-only">Expanded image preview</DialogTitle>
        <Button
          type="button"
          ref={closeButtonRef}
          size="icon-sm"
          variant="media-close"
          className="absolute right-0 top-0 z-20 pointer-coarse:size-11"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <XIcon />
        </Button>
        {preview.images.length > 1 && (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="left-0 top-auto bottom-0 translate-y-0 pointer-coarse:size-11 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Previous image"
            onClick={() => navigateImage(-1)}
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        )}
        <div className="relative isolate z-10 flex max-h-full max-w-[var(--media-width)] flex-col items-center">
          {item.src === null || failedImageSrc === item.src ? (
            <ExpandedMediaFailure>
              <p>Image unavailable. The file may have been removed.</p>
            </ExpandedMediaFailure>
          ) : (
            <ZoomableImage
              ref={zoomableImageRef}
              key={`${index}:${item.src}`}
              src={item.src}
              name={item.name}
              onError={() => setFailedImageSrc(item.src)}
            />
          )}
          <div className="mt-2 flex max-w-[var(--media-width)] items-center justify-center gap-1.5 text-xs text-white/80 max-sm:px-12">
            <span className="truncate" aria-live="polite" aria-atomic="true">
              {item.name}
              {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
            </span>
          </div>
        </div>
        {preview.images.length > 1 && (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="right-0 top-auto bottom-0 translate-y-0 pointer-coarse:size-11 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Next image"
            onClick={() => navigateImage(1)}
          >
            <ChevronRightIcon className="size-5" />
          </Button>
        )}
      </DialogPopup>
    </Dialog>
  );
});
