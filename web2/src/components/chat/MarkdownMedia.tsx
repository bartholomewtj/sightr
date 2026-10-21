// Sightr's own component, same job as T3 Code's
// apps/web/src/components/chat/ChatMarkdownMedia.tsx @ 688ee52f0e8f (MIT, see THIRD_PARTY.md).
// Sightr rule (T36): media loads only `http(s)` and `data:image` sources, so a `file://` URL, a
// workspace path or a missing `src` renders nothing the browser would fetch. T3 also opens the media
// full screen through its image viewer; this component is the inline frame only.
interface MarkdownMediaProps {
  src?: string;
  alt?: string;
  title?: string;
}

const SAFE_IMAGE_SRC = /^(?:https?:\/\/|data:image\/)/i;
const SAFE_HTTP_SRC = /^https?:\/\//i;
const VIDEO_EXTENSION = /\.(?:mp4|webm|mov)$/i;

/**
 * A markdown image (`![]()`) or a standalone video: a `<video>` for an `http(s)` source ending in
 * `.mp4`/`.webm`/`.mov`, an `<img>` for any other `http(s)` or `data:image` source, and nothing at all
 * otherwise. The video test comes first, so a clip is never drawn as an image. Images load lazily so a
 * long thread does not fetch every one on mount.
 */
export function MarkdownMedia({ src, alt, title }: MarkdownMediaProps) {
  if (typeof src !== "string") return null;
  const value = src.trim();
  if (SAFE_HTTP_SRC.test(value) && VIDEO_EXTENSION.test(value)) {
    return <video src={value} controls preload="metadata" className="max-w-full rounded-md" />;
  }
  if (SAFE_IMAGE_SRC.test(value)) {
    return (
      <img
        src={value}
        alt={alt}
        title={title}
        loading="lazy"
        decoding="async"
        className="max-w-full rounded-md"
      />
    );
  }
  return null;
}
