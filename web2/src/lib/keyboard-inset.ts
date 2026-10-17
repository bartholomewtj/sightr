// How much of the layout viewport the soft keyboard covers, as CSS variables on <html>:
//   --kb-inset  px the keyboard hides at the bottom (0px when none)
//   --kb-open   1 while it is up, else 0 (safe-area padding multiplies by `1 - var(--kb-open)`)
//
// Android Chrome (`interactive-widget=resizes-content`, index.html) shrinks the layout viewport itself,
// so 100dvh already excludes the keyboard and the inset reads 0. iOS Safari does not: the keyboard
// overlays a fixed sheet and the visual viewport shrinks while the layout viewport stays put, which
// would park a bottom sheet's key bar behind the keyboard. The inset is the gap between the layout
// viewport's bottom and the visual viewport's bottom. Pinch-zoom also changes the visual viewport, so
// a zoomed page reports 0 rather than a phantom keyboard.

/** Below this the "keyboard" is browser chrome moving (address bar), not a keyboard. */
export const KEYBOARD_MIN_PX = 80;
/** Pinch scale above which the visual viewport is zoomed, not squeezed. */
const ZOOM_EPSILON = 1.01;

export function keyboardInset(layoutHeight: number, vv: { height: number; offsetTop: number; scale: number }): number {
  if (vv.scale > ZOOM_EPSILON) return 0;
  const inset = Math.round(layoutHeight - vv.height - vv.offsetTop);
  return inset >= KEYBOARD_MIN_PX ? inset : 0;
}

let users = 0;
let stopListening: (() => void) | null = null;

function publish(root: HTMLElement, inset: number): void {
  root.style.setProperty("--kb-inset", `${inset}px`);
  root.style.setProperty("--kb-open", inset > 0 ? "1" : "0");
}

/**
 * Publish the variables while something that needs them is mounted (a sheet). Reference-counted, so
 * overlapping users share one listener. Returns the release function.
 */
export function watchKeyboardInset(): () => void {
  const vv = typeof window === "undefined" ? undefined : window.visualViewport;
  if (!vv) return () => {};
  users += 1;
  if (users === 1) {
    const root = document.documentElement;
    const update = () => publish(root, keyboardInset(window.innerHeight, vv));
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    stopListening = () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--kb-inset");
      root.style.removeProperty("--kb-open");
    };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users -= 1;
    if (users === 0) {
      stopListening?.();
      stopListening = null;
    }
  };
}
