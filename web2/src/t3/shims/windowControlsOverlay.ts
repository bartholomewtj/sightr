/**
 * Shim for T3 Code `~/lib/windowControlsOverlay` (apps/web/src/lib/windowControlsOverlay.ts @ e3b35d1b).
 * T3's tooltip offsets itself below an Electron titlebar overlay. Sightr is a browser PWA with no
 * native titlebar, so the height is always 0.
 */
export function useNativeTitlebarHeight(): number {
  return 0;
}
