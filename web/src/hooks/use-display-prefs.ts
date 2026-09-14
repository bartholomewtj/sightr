import { useCallback, useState } from "react";

// Terminal mirror display preferences, persisted in localStorage.
// Safe to call in SSR contexts (localStorage guarded throughout).

export interface DisplayPrefs {
  /** Font size in px for the mirror pre (default: 12, range: 9–16). */
  fontSize: number;
  /**
   * Raw-terminal mode (default: true). When on, the mirror renders the PLAIN terminal —
   * every Claude grammar (chrome stripping, native prompt-select buttons, the status strip) is
   * bypassed. Turn it off in Display settings to get tappable prompt buttons and chrome stripping.
   */
  rawTerminal: boolean;
  /**
   * Whether a tap on the terminal mirror focuses the composer (default: true).
   *
   * On, it is the fastest path from reading to replying — the whole mirror is one big "start typing"
   * target. Off, the mirror is a document: taps land on the text, so you can put a caret in it, and
   * the keyboard only appears when you tap the composer itself. Reported from the outside as the
   * mirror "absorbing the click", by someone expecting to interact with a line rather than reply to
   * it — which Sightr cannot offer (herdr's `pane.read` strips the OSC 8 hyperlinks a terminal like
   * Termux makes tappable, so the link target never reaches us). Getting out of the way is the part
   * that IS ours to give.
   */
  tapToFocus: boolean;
  /**
   * Show the live terminal dump alongside the journal (default: false). The pane opens on the
   * journal; the dump returns for blocked agents, armed Type, open Find, panes with no journal, and
   * unlifted blocking widgets; the composer's Terminal toggle flips it.
   */
  showTerminal: boolean;
  /**
   * Show model thought traces (default: true). On, the journal keeps collapsed "Thought for Ns"
   * rows you can expand, and the live pulse shows the last dump lines. Off hides the traces and
   * leaves only a timer while the agent works.
   */
  showThinking: boolean;
}

// v6: showTerminal default flipped to false (slice 3 of pane-screen redesign). A v5 payload has
// `showTerminal: true` written into it, so only a key bump gives existing installs the new
// first-open view. The migration carries forward fontSize, rawTerminal, and tapToFocus (clamped
// and type-checked the same way loadPrefs does now), while showTerminal takes the new default.
// The v5 key is deleted after the one-time copy. New fields added later use their defaults rather
// than forcing another bump.
const STORAGE_KEY = "sightr:display-prefs:v6";
const LEGACY_KEY = "sightr:display-prefs:v5";
export const FONT_MIN = 9;
export const FONT_MAX = 16;
const BASE_DEFAULTS: DisplayPrefs = {
  fontSize: 12,
  rawTerminal: true,
  tapToFocus: true,
  showTerminal: false,
  showThinking: true,
};
function defaults(): DisplayPrefs {
  return { ...BASE_DEFAULTS };
}

function clampFont(n: number): number {
  return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
}

function parsePrefs(raw: string | null): DisplayPrefs | null {
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  return {
    fontSize: typeof p.fontSize === "number" ? clampFont(p.fontSize) : BASE_DEFAULTS.fontSize,
    rawTerminal: typeof p.rawTerminal === "boolean" ? p.rawTerminal : BASE_DEFAULTS.rawTerminal,
    tapToFocus: typeof p.tapToFocus === "boolean" ? p.tapToFocus : BASE_DEFAULTS.tapToFocus,
    showTerminal: typeof p.showTerminal === "boolean" ? p.showTerminal : BASE_DEFAULTS.showTerminal,
    showThinking: typeof p.showThinking === "boolean" ? p.showThinking : BASE_DEFAULTS.showThinking,
  };
}

function loadPrefs(): DisplayPrefs {
  try {
    if (typeof localStorage === "undefined") return defaults();
    const current = parsePrefs(localStorage.getItem(STORAGE_KEY));
    if (current) return current;
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw === null) return defaults();
    const legacy = parsePrefs(legacyRaw);
    // Carry the old choices forward, but take the NEW showTerminal default — the point of the bump.
    const migrated: DisplayPrefs = legacy
      ? { ...legacy, showTerminal: BASE_DEFAULTS.showTerminal }
      : defaults();
    savePrefs(migrated);
    localStorage.removeItem(LEGACY_KEY);
    return migrated;
  } catch {
    return defaults();
  }
}

function savePrefs(prefs: DisplayPrefs): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    }
  } catch {
    // Ignore quota / SSR write errors.
  }
}

export interface UseDisplayPrefsReturn {
  prefs: DisplayPrefs;
  /** Set font size, clamped to 9–16. */
  setFontSize: (size: number) => void;
  /** Step font size by delta (positive = larger), clamped to 9–16. */
  stepFontSize: (delta: number) => void;
  /** Toggle or explicitly set raw-terminal mode. */
  setRawTerminal: (raw: boolean) => void;
  /** Toggle or explicitly set whether a mirror tap focuses the composer. */
  setTapToFocus: (tapToFocus: boolean) => void;
  /** Toggle or explicitly set whether the live terminal dump is shown. */
  setShowTerminal: (showTerminal: boolean) => void;
  /** Toggle or explicitly set whether thought traces are shown. */
  setShowThinking: (showThinking: boolean) => void;
}

export function useDisplayPrefs(): UseDisplayPrefsReturn {
  const [prefs, setPrefs] = useState<DisplayPrefs>(loadPrefs);

  const setFontSize = useCallback((size: number) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, fontSize: clampFont(size) };
      savePrefs(next);
      return next;
    });
  }, []);

  const stepFontSize = useCallback((delta: number) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, fontSize: clampFont(p.fontSize + delta) };
      savePrefs(next);
      return next;
    });
  }, []);

  const setRawTerminal = useCallback((rawTerminal: boolean) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, rawTerminal };
      savePrefs(next);
      return next;
    });
  }, []);

  const setTapToFocus = useCallback((tapToFocus: boolean) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, tapToFocus };
      savePrefs(next);
      return next;
    });
  }, []);

  const setShowTerminal = useCallback((showTerminal: boolean) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, showTerminal };
      savePrefs(next);
      return next;
    });
  }, []);

  const setShowThinking = useCallback((showThinking: boolean) => {
    setPrefs((p) => {
      const next: DisplayPrefs = { ...p, showThinking };
      savePrefs(next);
      return next;
    });
  }, []);

  return {
    prefs,
    setFontSize,
    stepFontSize,
    setRawTerminal,
    setTapToFocus,
    setShowTerminal,
    setShowThinking,
  };
}
