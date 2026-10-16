// Vitest runs without the VitePWA plugin, so `virtual:pwa-register` does not exist; this stands in.
export function registerSW(_options?: unknown): (reloadPage?: boolean) => Promise<void> {
  return () => Promise.resolve();
}
