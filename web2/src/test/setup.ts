import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";

import { __resetConnTelemetry } from "@v1/lib/conn-telemetry";

import { __resetCommandPalette } from "@/commandPaletteBus";
import { useShortcutsDialog } from "@/components/KeyboardShortcutsDialog";
import { __resetToasts } from "@/components/toast";
import { __resetThreadUndoNotice } from "@/hooks/showThreadUndoNotice";
import { __resetPaneCache } from "@/lib/api";
import { __reloadDisplayPrefs } from "@/hooks/use-display-prefs";
import { __reloadTheme } from "@/hooks/use-theme";
import { __resetDraftPrune } from "@/lib/drafts";
import { __resetFilesTree } from "@/lib/files-tree";
import { clearLockRequired } from "@/lib/lock";
import { __resetOperatorCommands } from "@/lib/operator-commands";
import { __resetPasteHold } from "@/lib/paste-hold";
import { __resetServerBuild } from "@/lib/server-build";
import { __resetDiffPanelStore } from "@/diffPanelStore";
import { __resetDiffMemory } from "@/components/diffs/diffPanelMemory";
import { __resetDiffRootPaths } from "@/components/diffs/diffRootPath";
import { __resetSheetHistory } from "@/components/sheetHistory";
import { __resetRightPanelStore } from "@/rightPanelStore";
import { __resetComposerState } from "@/state/composer";
import { __resetDraftThread } from "@/state/draft-thread";
import { __resetSidebarState } from "@/state/sidebar";
import { __resetTextPrefs } from "@/state/text-prefs";
import { __resetThreadDefaults } from "@/state/thread-defaults";
import { __resetTimelineState } from "@/state/timeline";
import { __resetShellStream } from "@/stream/shell-stream";
import { __resetStreamStores } from "@/stream/stores";
import { __resetThreadStream } from "@/stream/thread-stream";
import { __resetThreadViewStore } from "@/threadViewStore";
import { __resetUiState } from "@/uiStateStore";

import { FakeEventSource } from "./fake-event-source";
import { installMatchMedia, resetMedia } from "./media";

/** Default bridge: no lock, telemetry accepted. Tests add `server.use(...)` per case. */
export const handlers = [
  http.get("/api/lock", () => HttpResponse.json({ enabled: false, unlocked: true })),
  http.post("/api/conn", () => new HttpResponse(null, { status: 204 })),
  http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "" })),
];

export const server = setupServer(...handlers);

// jsdom has neither EventSource nor a working matchMedia.
Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: FakeEventSource });
installMatchMedia();
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
window.scrollTo = () => {};

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
  __resetConnTelemetry();
  __reloadDisplayPrefs();
  __reloadTheme();
  __resetThreadDefaults();
  __resetTextPrefs();
  __resetServerBuild();
  __resetShellStream();
  __resetThreadStream();
  __resetStreamStores();
  __resetUiState();
  __resetRightPanelStore();
  __resetDiffPanelStore();
  __resetDiffMemory();
  __resetDiffRootPaths();
  __resetSheetHistory();
  __resetThreadViewStore();
  __resetCommandPalette();
  useShortcutsDialog.setState({ open: false });
  __resetPaneCache();
  __resetFilesTree();
  __resetPasteHold();
  __resetSidebarState();
  __resetTimelineState();
  __resetComposerState();
  __resetDraftThread();
  __resetDraftPrune();
  __resetOperatorCommands();
  __resetToasts();
  __resetThreadUndoNotice();
  clearLockRequired();
  FakeEventSource.reset();
  resetMedia();
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
