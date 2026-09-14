import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

/** Cream-disk knockout. Rest mark on dark paper; tab/OS icons are the separate favicon set. */
export const MARK_SRC = "/sightr-badge.svg";
/** Navy-disk knockout. Rest mark on light paper. */
export const MARK_LIGHT_SRC = "/sightr-badge-light.svg";
const RUN_SRC = "/sightr-loading-badge.svg";
const RUN_LIGHT_SRC = "/sightr-loading-badge-light.svg";

interface DogGallopProps {
  /** Play the sightr loader (ticks spin, bison gallops). When false, the static badge. */
  running?: boolean;
  /** Any CSS length for the (square) render size. Defaults to 1.5rem — the header logo size. */
  size?: string;
  /** Accessible name. Omit to render the mark as decorative (aria-hidden). */
  label?: string;
  className?: string;
}

function Pair({ dark, light, className }: { dark: string; light: string; className?: string }) {
  // Two files because an SVG loaded as <img> cannot see page CSS variables. Cream disk on dark
  // paper, navy disk on light. `dark:` follows the same pin-or-OS rule as the rest of the app.
  return (
    <>
      <img src={dark} alt="" aria-hidden="true" className={cn("hidden size-full dark:block", className)} />
      <img src={light} alt="" aria-hidden="true" className={cn("size-full dark:hidden", className)} />
    </>
  );
}

/** Static sightr knockout badge. Cream on dark, navy on light. */
export function SightrMark({ className, muted = false }: { className?: string; muted?: boolean }) {
  return (
    <span className={cn("inline-block", muted && "opacity-40 grayscale", className)}>
      <Pair dark={MARK_SRC} light={MARK_LIGHT_SRC} />
    </span>
  );
}

// Activity indicator: the sightr knockout loader (ticks spin, the bison hole gallops) while
// `running`. The animation lives inside the SVG and already honours prefers-reduced-motion.
// Must be an <img>, not a CSS background — browsers drop SVG CSS animations on background-image.
//
// Rest is the static badge, not a paused run-frame. Callers that mean "at rest" should mount
// <SightrMark/> so a reduced-motion user never sees the loader file at all.
export function DogGallop({ running = false, size = "1.5rem", label, className }: DogGallopProps) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ "--dog-size": size } as CSSProperties}
      className={cn("dog-gallop", running && "dog-gallop--running", className)}
    >
      <Pair
        dark={running ? RUN_SRC : MARK_SRC}
        light={running ? RUN_LIGHT_SRC : MARK_LIGHT_SRC}
      />
    </span>
  );
}
