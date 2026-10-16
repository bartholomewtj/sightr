import { registerSW } from "virtual:pwa-register";

// Registers /v2/sw.js with scope /v2/ (vite-plugin-pwa derives both from `base`) and checks for a
// newer worker once a minute. A new worker takes over on its own (sw.ts skips waiting). The richer
// update flow v1 has (lib/pwa-update.ts) can come over with T18 if the v2 PWA needs it.
const UPDATE_CHECK_MS = 60_000;

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    setInterval(() => void registration.update().catch(() => {}), UPDATE_CHECK_MS);
  },
});
