import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MAX_HELD_PRESSES, runGuardedSend, type GuardedSendIo } from "./guarded-send";
import { composerFor } from "./harness/composer-kit";

// The reply guard on Pi, over live Pi captures. The bug this pins: a new thread's first message was
// typed into Pi before its startup ended. Pi refused the Enter ("Startup is still in progress"), put
// the text back in the editor, and nothing ever pressed Enter again.

const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const raw = (name: string) => readFileSync(join(PANES_DIR, name), "utf8");

const MESSAGE =
  "List the files in the web2/src/components/chat folder that end in .logic.ts, then tell me which is largest. Keep it to two sentences.";
const IDLE = raw("pi--idle-empty.txt");
const HELD = raw("pi--startup-in-progress.txt");
const STARTED = raw("pi--startup-done-draft.txt");
/** The empty editor's one row: the cursor cell, then padding. */
const EMPTY_ROW = /^\x1b\[0m\x1b\[7m \x1b\[0m */m;
/** The idle editor holding `draft` (the same row Pi draws, cursor at the end). */
const typed = (draft: string) => IDLE.replace(EMPTY_ROW, `${draft}\x1b[0m\x1b[7m \x1b[0m`);

const pi = composerFor("pi")!;

/** A scripted pane: `screen` decides what each read shows from what has been typed and pressed. */
function pane(screen: (s: { typed: string; presses: number; reads: number }) => string) {
  const state = { typed: "", presses: 0, reads: 0 };
  const events: string[] = [];
  const io: GuardedSendIo = {
    read: async () => {
      state.reads += 1;
      return screen(state);
    },
    type: async (text) => {
      events.push(`type:${text}`);
      state.typed += text;
      return { ok: true };
    },
    submit: async (keys) => {
      events.push(`submit:${(keys ?? ["<default>"]).join("+")}`);
      state.presses += 1;
      return { ok: true };
    },
    oneShot: async (text) => {
      events.push(`oneShot:${text}`);
      return { ok: true };
    },
    sleep: async () => {},
    pollAttempts: 8,
    pollDelayMs: 350,
  };
  return { io, events, state };
}

describe("reply guard on pi", () => {
  it("verifies the text in Pi's editor before submitting (no more one-shot)", async () => {
    const p = pane((s) => (s.typed === "" ? IDLE : s.presses > 0 ? IDLE : typed(s.typed)));
    const out = await runGuardedSend(pi, p.io, { text: MESSAGE });
    expect(out).toEqual({ status: "sent" });
    expect(p.events).toEqual([`type:${MESSAGE}`, "submit:<default>"]);
  });

  it("never submits text that did not reach the editor", async () => {
    const p = pane(() => IDLE);
    const out = await runGuardedSend(pi, p.io, { text: MESSAGE });
    expect(out.status).toBe("stalled");
    expect(p.events).toEqual([`type:${MESSAGE}`]);
  });

  it("rescue: an Enter Pi swallowed is pressed again while our text is still in the box", async () => {
    // Not startup: the first press just did nothing, so the box still shows the text, not held.
    const p = pane((s) => (s.typed === "" ? IDLE : s.presses >= 2 ? IDLE : typed(s.typed)));
    const out = await runGuardedSend(pi, p.io, { text: MESSAGE });
    expect(out).toEqual({ status: "sent" });
    expect(p.events).toEqual([`type:${MESSAGE}`, "submit:<default>", "submit:Enter"]);
  });

  it("startup: no Enter while Pi says startup is in progress; one Enter once it has moved on", async () => {
    // The first press lands during startup: Pi keeps the text and prints the marker. Ten reads later
    // its startup has printed past the marker, and the next Enter submits.
    let heldUntil = -1;
    const p = pane((s) => {
      if (s.typed === "") return IDLE;
      if (s.presses === 0) return typed(s.typed);
      if (s.presses === 1) {
        if (heldUntil < 0) heldUntil = s.reads + 40;
        return s.reads < heldUntil ? HELD : STARTED;
      }
      return IDLE;
    });
    const out = await runGuardedSend(pi, p.io, { text: MESSAGE });
    expect(out).toEqual({ status: "sent" });
    expect(p.events).toEqual([`type:${MESSAGE}`, "submit:<default>", "submit:Enter"]);
    // The second press came only after the held screens: the read count passed the hold.
    expect(p.state.reads).toBeGreaterThan(heldUntil);
  });

  it("startup: the first Enter waits too when the marker is already up when the text lands", async () => {
    let pressedAtRead = -1;
    const p = pane((s) => {
      if (s.typed === "") return IDLE;
      if (s.presses > 0) {
        if (pressedAtRead < 0) pressedAtRead = s.reads;
        return IDLE;
      }
      return s.reads < 20 ? HELD : STARTED;
    });
    const out = await runGuardedSend(pi, p.io, { text: MESSAGE });
    expect(out).toEqual({ status: "sent" });
    expect(p.events).toEqual([`type:${MESSAGE}`, "submit:<default>"]);
    expect(pressedAtRead).toBeGreaterThanOrEqual(20);
  });

  it("startup that outlasts the wait: bounded presses, and the text is reported in the box, not resent", async () => {
    const p = pane((s) => (s.typed === "" ? IDLE : HELD));
    const out = await runGuardedSend(pi, p.io, { text: MESSAGE });
    expect(out).toEqual(expect.objectContaining({ status: "error", textDelivered: true }));
    const presses = p.events.filter((e) => e.startsWith("submit:"));
    expect(presses.length).toBeGreaterThanOrEqual(1);
    expect(presses.length).toBeLessThanOrEqual(MAX_HELD_PRESSES);
    expect(p.events.filter((e) => e.startsWith("type:"))).toHaveLength(1);
  });

  it("never presses into an empty editor: a box that emptied after the first Enter is a sent message", async () => {
    const p = pane((s) => (s.typed === "" || s.presses > 0 ? IDLE : typed(s.typed)));
    await runGuardedSend(pi, p.io, { text: MESSAGE });
    expect(p.events.filter((e) => e.startsWith("submit:"))).toHaveLength(1);
  });

  it("no Enter at all when the text left the box before any press", async () => {
    // Our text verified, then (an operator in the terminal) the box was cleared before we pressed.
    let verified = false;
    const p = pane((s) => {
      if (s.typed === "") return IDLE;
      if (!verified) {
        verified = true;
        return typed(s.typed);
      }
      return IDLE;
    });
    const out = await runGuardedSend(pi, p.io, { text: MESSAGE });
    expect(out).toEqual(expect.objectContaining({ status: "error", textDelivered: true }));
    expect(p.events.filter((e) => e.startsWith("submit:"))).toEqual([]);
  });
});
