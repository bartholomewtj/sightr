/**
 * The Terminal tab (T13): v1's live mirror as a tool beside the timeline. It reads the pane only while
 * this tab is mounted and the page is visible (`useMirror`). "Type into terminal" (or ctrl+`) arms
 * direct typing: keystrokes go straight to `POST /api/pane/:id/keys` with no reply guard, and the mode
 * disarms on blur, a failed batch or a hidden page (v1's `useDirectTyping`, copied). The Keys pad docks
 * under the mirror on a phone or a touch screen. A read-only device sees the mirror only.
 */
import { ArrowDownIcon, KeyboardIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { parseLines, trimTrailingBlank } from "@v1/lib/blocks";
import { ctrlPresetsFor } from "@v1/lib/operator-keys";
import { Button } from "~/components/ui/button";
import { NavTray } from "@/components/keys/nav-tray";
import { useDirectTyping } from "@/hooks/use-direct-typing";
import { useLayout } from "@/hooks/useLayout";
import { MIRROR_COLD_MS, useMirror } from "@/hooks/useMirror";
import { sendKeys } from "@/lib/api";
import { useOperatorKeys } from "@/lib/operator-commands";
import { TERMINAL_FONT_MAX, TERMINAL_FONT_MIN, useRightPanelStore } from "@/rightPanelStore";
import { useShortcutHandler } from "@/shortcutHandlers";
import { useSidebarThread } from "@/state/sidebar";
import { useBridgeInfo, useStreamHealth, useThread } from "@/stream/stores";

import { DirectTypingStrip } from "./DirectTypingStrip";
import { TerminalMirror } from "./TerminalMirror";

/** v1's base window (the bridge itself caps a shell pane's read at 120 visible lines). */
export const BASE_LINES = 600;
/** "Load older" steps (v1 `DETAIL_HISTORY_STEP`) up to herdr's real ceiling. */
export const LINES_STEP = 600;
export const LINES_MAX = 1_000;
/** How close to the bottom still counts as following the tail. */
const FOLLOW_SLACK_PX = 24;

const COARSE_QUERY = "(pointer: coarse)";
function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    (on) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const mql = window.matchMedia(COARSE_QUERY);
      mql.addEventListener("change", on);
      return () => mql.removeEventListener("change", on);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(COARSE_QUERY).matches,
    () => false,
  );
}

export function TerminalPanel({ threadId }: { threadId: string }) {
  const state = useThread(threadId);
  const shellThread = useSidebarThread(threadId);
  const thread = state?.thread ?? shellThread ?? null;
  const paneId = thread?.paneId || null;
  const readOnly = useBridgeInfo((s) => s.readOnly);
  const linkLost = useStreamHealth((s) => s.status === "lost");
  const desktop = useLayout() === "desktop";
  const coarse = useCoarsePointer();
  const fontSize = useRightPanelStore((s) => s.terminalFontSize);
  const setFontSize = useRightPanelStore((s) => s.setTerminalFontSize);
  const request = useRightPanelStore((s) => s.directTyping);
  const consumeRequest = useRightPanelStore((s) => s.consumeDirectTyping);
  const operatorKeys = useOperatorKeys();

  const [lines, setLines] = useState(BASE_LINES);
  const [keysOpen, setKeysOpen] = useState(false);
  const [prompt, setPrompt] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const archived = thread?.shelf === "archived";
  const writable = !readOnly && !archived && paneId !== null;

  const mirrorRef = useRef<{ refresh: () => void }>({ refresh: () => {} });
  const typing = useDirectTyping({
    paneKey: paneId ?? "",
    inputRef,
    replyDraft: () => "",
    canActivate: () => writable,
    suspended: !writable,
    sendKeys: (keys) =>
      paneId === null
        ? Promise.resolve(false)
        : sendKeys(paneId, keys, true)
            .then((r) => {
              mirrorRef.current.refresh();
              return r.ok;
            })
            .catch(() => false),
    onActivate: () => {},
    focusInput: () => setTimeout(() => inputRef.current?.focus(), 0),
    desktop,
  });

  const mirror = useMirror(paneId, { hot: typing.active || thread?.status === "working", lines });
  mirrorRef.current = mirror;
  const styled = useMemo(() => (mirror.text === null ? [] : trimTrailingBlank(parseLines(mirror.text))), [mirror.text]);

  useEffect(() => {
    if (!typing.active) setPrompt(undefined);
  }, [typing.active]);

  // ── ctrl+`: toggle direct typing while this tab is mounted ──
  useShortcutHandler("terminal.directTyping", () => {
    if (!writable) return false;
    if (typing.active) typing.deactivate();
    else typing.activate();
  });

  // ── A request to arm (T12's password hand-off, or ctrl+` before the tab was open) ──
  useEffect(() => {
    if (!request || request.threadId !== threadId) return;
    consumeRequest(request.id);
    if (!writable) return;
    setPrompt(request.prompt);
    typing.activate();
    // `typing` is a fresh object each render; the request id is what this effect follows.
  }, [request?.id, threadId, writable]);

  // ── Follow the tail ──
  useEffect(() => {
    const el = scrollRef.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [styled]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
    following.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
  };
  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    following.current = true;
    setAtBottom(true);
  };

  if (!thread) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (!paneId) return <p className="p-4 text-sm text-muted-foreground">This thread has no pane yet.</p>;

  // Older lines may exist only when the read filled the window it asked for (a shell pane, or a
  // short scrollback, comes back shorter; no harness check needed).
  const canLoadOlder = lines < LINES_MAX && mirror.text !== null && mirror.text.split("\n").length >= lines;
  const showKeysPad = writable && (!desktop || coarse);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-terminal-tab="">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        {writable ? (
          <Button
            size="xs"
            variant={typing.active ? "default" : "outline"}
            aria-pressed={typing.active}
            disabled={linkLost}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => (typing.active ? typing.deactivate() : typing.activate())}
          >
            <KeyboardIcon className="size-3.5" aria-hidden="true" />
            {typing.active ? "Stop typing" : "Type into terminal"}
          </Button>
        ) : null}
        {showKeysPad ? (
          <Button size="xs" variant={keysOpen ? "outline" : "ghost-muted"} aria-pressed={keysOpen} onClick={() => setKeysOpen((v) => !v)}>
            Keys
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Smaller text"
          disabled={fontSize <= TERMINAL_FONT_MIN}
          onClick={() => setFontSize(fontSize - 1)}
        >
          <MinusIcon />
        </Button>
        <span className="w-8 text-center font-mono text-2xs tabular-nums text-muted-foreground" aria-label="Text size">
          {fontSize}px
        </span>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Larger text"
          disabled={fontSize >= TERMINAL_FONT_MAX}
          onClick={() => setFontSize(fontSize + 1)}
        >
          <PlusIcon />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          data-terminal-mirror=""
          tabIndex={0}
          aria-label="Terminal"
          onScroll={onScroll}
          className="absolute inset-0 overflow-y-auto bg-[#0a0a0a] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {canLoadOlder && mirror.text !== null ? (
            <div className="flex justify-center py-1">
              <Button size="xs" variant="ghost-muted" onClick={() => setLines((n) => Math.min(n + LINES_STEP, LINES_MAX))}>
                Load older
              </Button>
            </div>
          ) : null}
          {mirror.text === null ? (
            <p className="p-3 text-sm text-muted-foreground">{mirror.error ? "Couldn't read the pane." : "Reading the pane…"}</p>
          ) : (
            <TerminalMirror lines={styled} fontSize={fontSize} className="p-2" />
          )}
        </div>
        {!atBottom ? (
          <Button size="xs" variant="secondary" className="absolute bottom-2 left-1/2 -translate-x-1/2 shadow" onClick={jumpToLatest}>
            <ArrowDownIcon className="size-3.5" aria-hidden="true" />
            Jump to latest
          </Button>
        ) : null}
      </div>
      {mirror.error && mirror.text !== null ? (
        <p role="status" className="border-t px-3 py-1 text-xs text-warn">
          The mirror stopped updating. Retrying every {MIRROR_COLD_MS / 1000} s.
        </p>
      ) : null}
      {writable ? (
        // Always mounted, so arming can focus it inside the tap (a phone opens its keyboard only for
        // a focus made during the gesture); out of sight and out of the tab order until armed.
        <div className={typing.active ? "border-t px-2 pt-1 pb-2" : "sr-only"} data-direct-typing={typing.active ? "armed" : "off"}>
          {typing.active ? <DirectTypingStrip onStop={typing.deactivate} {...(prompt ? { prompt } : {})} /> : null}
          <textarea
            ref={inputRef}
            aria-label="Type into the terminal"
            aria-hidden={!typing.active}
            tabIndex={typing.active ? 0 : -1}
            rows={1}
            value={typing.value}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="send"
            placeholder="Keys go straight to the pane"
            className="block w-full resize-none rounded-lg border border-primary/60 bg-background px-2 py-1.5 font-mono text-base text-foreground outline-none sm:text-sm"
            onChange={typing.active ? typing.onChange : () => {}}
            onCompositionStart={typing.onCompositionStart}
            onCompositionEnd={typing.onCompositionEnd}
            onKeyDown={typing.active ? typing.onKeyDown : undefined}
            onBlur={typing.onBlur}
          />
        </div>
      ) : null}
      {showKeysPad && keysOpen ? (
        <div data-keys-dock="true" className="border-t bg-card p-1.5">
          <NavTray
            onSend={(keys) =>
              sendKeys(paneId, keys)
                .then((r) => {
                  mirror.refresh();
                  return r.ok;
                })
                .catch(() => false)
            }
            presets={ctrlPresetsFor(thread.harness, operatorKeys)}
            disabled={linkLost}
          />
        </div>
      ) : null}
    </div>
  );
}
