import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  multiSelectAdvanceRecipe,
  multiSelectApplyRecipe,
  pollModel,
  POLL_ATTEMPTS,
  previewSelectRecipe,
  type RecipeIO,
  type RecipeResult,
} from "./dialog-recipes";
import type { MultiSelectModel } from "./harness/multi-select-model";
import type { PreviewSelectModel } from "./harness/preview-model";

// The recipes are pure over their injected I/O: these tests drive them against small simulated
// dialogs that react to keys the way the TUIs do, and check exactly which keys went out.

const noSleep = async () => {};

interface Sent {
  keys: string[];
  region?: string;
}

/** A simulated pane: `model()` is what a read shows, `press` reacts to each key. */
function simIO<M>(sim: { model(): M | null; press(key: string): void }, sent: Sent[]): RecipeIO<M> {
  return {
    read: async () => sim.model(),
    send: async (keys, region): Promise<RecipeResult> => {
      sent.push(region === undefined ? { keys } : { keys, region });
      for (const k of keys) sim.press(k);
      return { status: "sent" };
    },
    sleep: noSleep,
  };
}

const keysOf = (sent: Sent[]) => sent.flatMap((s) => s.keys);

// ── Claude multi-select ─────────────────────────────────────────────────────────────────────────

const LABELS = ["Cheese", "Mushrooms", "Olives", "Peppers"];
/** Rows the ❯ pointer walks: the boxes, the free-text row, the advance row, Chat about this. */
const ROW_OTHER = LABELS.length;
const ROW_ADVANCE = LABELS.length + 1;
const ROW_CHAT = LABELS.length + 2;

function claudeMulti(checked: boolean[], row: number, signature = "sig"): MultiSelectModel {
  return {
    phase: "checkbox",
    question: "Which toppings?",
    options: LABELS.map((label, i) => ({ n: i + 1, label, checked: checked[i]! })),
    escape: { n: 6, label: "Chat about this" },
    pointer: row < ROW_OTHER ? "option" : row === ROW_OTHER ? "other" : row === ROW_ADVANCE ? "advance" : "chat",
    steps: [
      { label: "Toppings", answered: checked.some(Boolean), current: true },
      { label: "Crust", answered: false, current: false },
    ],
    advanceLabel: "Next",
    signature,
    regionSignature: `region ${checked.join(",")} ${row}`,
  };
}

function claudeSim(start: boolean[], row = 0) {
  const state = { checked: [...start], row, phase: "checkbox" as "checkbox" | "next", lag: 0 };
  return {
    state,
    model: (): MultiSelectModel | null =>
      state.phase === "next" ? { ...claudeMulti(state.checked, 0, "next-question") } : claudeMulti(state.checked, state.row),
    press(key: string) {
      // A digit toggles its box and leaves the pointer where it is (seen live on Claude Code 2.1.301).
      if (/^[1-4]$/.test(key)) {
        const i = Number(key) - 1;
        state.checked[i] = !state.checked[i];
      } else if (key === "Down") state.row = Math.min(state.row + 1, ROW_CHAT);
      else if (key === "Up") state.row = Math.max(state.row - 1, 0);
      else if (key === "Enter" && state.row === ROW_ADVANCE) state.phase = "next";
    },
  };
}

describe("multiSelectApplyRecipe — Claude", () => {
  it("toggles only the boxes that differ, then walks to Next and presses Enter", async () => {
    const sim = claudeSim([true, true, false, false]);
    const sent: Sent[] = [];
    const res = await multiSelectApplyRecipe(simIO(sim, sent), sim.model()!, [true, false, true, false], "bound");
    expect(res).toEqual({ status: "sent" });
    // Box 2 off, box 3 on, then Down from the first row past the free-text row to the advance row.
    expect(keysOf(sent)).toEqual(["2", "3", "Down", "Down", "Down", "Down", "Down", "Enter"]);
    expect(sim.state).toMatchObject({ checked: [true, false, true, false], phase: "next" });
  });

  it("binds only the first write to the region", async () => {
    const sim = claudeSim([false, false, false, false]);
    const sent: Sent[] = [];
    await multiSelectApplyRecipe(simIO(sim, sent), sim.model()!, [true, true, false, false], "bound");
    expect(sent[0]).toEqual({ keys: ["1"], region: "bound" });
    expect(sent.slice(1).every((s) => s.region === undefined)).toBe(true);
  });

  it("with the set already on screen it only submits", async () => {
    const sim = claudeSim([false, true, false, false], ROW_CHAT);
    const sent: Sent[] = [];
    expect(await multiSelectApplyRecipe(simIO(sim, sent), sim.model()!, [false, true, false, false], undefined)).toEqual({ status: "sent" });
    // The pointer starts on Chat about this: Up once onto the advance row.
    expect(keysOf(sent)).toEqual(["Up", "Enter"]);
  });

  it("a box flipped by another device during the walk aborts before Enter", async () => {
    const sim = claudeSim([false, false, false, false]);
    const sent: Sent[] = [];
    const io = simIO(sim, sent);
    const send = io.send;
    io.send = async (keys, region) => {
      const res = await send(keys, region);
      if (keys[0] === "Down") sim.state.checked[3] = true; // someone at the desk ticks Peppers
      return res;
    };
    const res = await multiSelectApplyRecipe(io, sim.model()!, [true, false, false, false], undefined);
    expect(res).toEqual({ status: "changed" });
    expect(keysOf(sent)).not.toContain("Enter");
  });

  it("a toggle that lands on a different box aborts", async () => {
    const sim = claudeSim([false, false, false, false]);
    const sent: Sent[] = [];
    const io = simIO(sim, sent);
    sim.press = (key) => {
      if (key === "1") sim.state.checked[1] = true; // the screen moved under us: box 2 flipped instead
    };
    expect(await multiSelectApplyRecipe(io, sim.model()!, [true, false, false, false], undefined)).toEqual({ status: "changed" });
    expect(keysOf(sent)).toEqual(["1"]);
  });

  it("a toggle the TUI never draws times out without a further key", async () => {
    const sim = claudeSim([false, false, false, false]);
    const sent: Sent[] = [];
    sim.press = () => {};
    expect(await multiSelectApplyRecipe(simIO(sim, sent), sim.model()!, [true, false, false, false], undefined)).toEqual({ status: "changed" });
    expect(keysOf(sent)).toEqual(["1"]);
  });

  it("the advance walk refuses another dialog on the first read", async () => {
    const sim = claudeSim([false, false, false, false]);
    const sent: Sent[] = [];
    const tapped = claudeMulti([false, false, false, false], 0, "other-dialog");
    expect(await multiSelectAdvanceRecipe(simIO(sim, sent), tapped, undefined)).toEqual({ status: "changed" });
    expect(sent).toEqual([]);
  });
});

// ── Grok (tab-space-enter) and Cursor (pointer-space-s) ─────────────────────────────────────────

function widget(recipe: "tab-space-enter" | "pointer-space-s", checked: boolean[], focusedN: number | null): MultiSelectModel {
  return {
    phase: "checkbox",
    question: "Which toppings?",
    options: LABELS.map((label, i) => ({ n: i + 1, label, checked: checked[i]! })),
    escape: null,
    pointer: "option",
    steps: null,
    advanceLabel: "Submit",
    recipe,
    focusedN,
    signature: "sig",
    regionSignature: "region",
  };
}

describe("multiSelectApplyRecipe — Grok tab-space-enter", () => {
  it("Tab-walks to each box, Space toggles it, Enter submits", async () => {
    const state = { checked: [false, false, false, false], focused: 1 as number | null, submitted: false };
    const sim = {
      model: () => (state.submitted ? null : widget("tab-space-enter", state.checked, state.focused)),
      press(key: string) {
        if (key === "Tab") state.focused = state.focused === null ? 1 : Math.min(state.focused + 1, 4);
        else if (key === "Space" && state.focused !== null) state.checked[state.focused - 1] = !state.checked[state.focused - 1];
        else if (key === "Enter") state.submitted = true;
      },
    };
    const sent: Sent[] = [];
    expect(await multiSelectApplyRecipe(simIO(sim, sent), sim.model()!, [false, true, false, true], "bound")).toEqual({ status: "sent" });
    expect(keysOf(sent)).toEqual(["Tab", "Space", "Tab", "Tab", "Space", "Enter"]);
    expect(sent[0]!.region).toBe("bound");
    expect(state).toMatchObject({ checked: [false, true, false, true], submitted: true });
    // Digits submit on that widget: none may ever go out.
    expect(keysOf(sent).some((k) => /^\d$/.test(k))).toBe(false);
  });
});

describe("multiSelectApplyRecipe — Cursor pointer-space-s", () => {
  it("walks the pointer to each box, Space toggles it, s submits", async () => {
    const state = { checked: [false, false, false, false], focused: 3 as number | null, submitted: false };
    const sim = {
      model: () => (state.submitted ? null : widget("pointer-space-s", state.checked, state.focused)),
      press(key: string) {
        if (key === "Up") state.focused = state.focused === null ? 4 : Math.max(state.focused - 1, 1);
        else if (key === "Down") state.focused = state.focused === 4 ? null : (state.focused ?? 4) + 1;
        else if (key === "Space" && state.focused !== null) state.checked[state.focused - 1] = !state.checked[state.focused - 1];
        else if (key === "s") state.submitted = true;
      },
    };
    const sent: Sent[] = [];
    expect(await multiSelectApplyRecipe(simIO(sim, sent), sim.model()!, [true, false, false, false], undefined)).toEqual({ status: "sent" });
    expect(keysOf(sent)).toEqual(["Up", "Up", "Space", "s"]);
  });

  it("steps off the Other: row before s", async () => {
    const state = { checked: [true, false, false, false], focused: null as number | null, submitted: false };
    const sim = {
      model: () => (state.submitted ? null : widget("pointer-space-s", state.checked, state.focused)),
      press(key: string) {
        if (key === "Up") state.focused = state.focused === null ? 4 : Math.max(state.focused - 1, 1);
        else if (key === "s") state.submitted = true;
      },
    };
    const sent: Sent[] = [];
    expect(await multiSelectApplyRecipe(simIO(sim, sent), sim.model()!, [true, false, false, false], undefined)).toEqual({ status: "sent" });
    expect(keysOf(sent)).toEqual(["Up", "s"]);
  });
});

// ── Preview select ──────────────────────────────────────────────────────────────────────────────

function previewModel(pointed: number, core = "core"): PreviewSelectModel {
  return {
    question: "Which layout?",
    options: ["Grid", "List", "Cards"].map((label, i) => ({ label, n: i + 1, pointed: i === pointed, chosen: false })),
    preview: [`preview of ${pointed}`],
    note: { state: "none", text: "" },
    steps: null,
    regionSignature: `region ${pointed}`,
    coreSignature: core,
  };
}

describe("previewSelectRecipe", () => {
  it("sends the digit, waits for the pointer on that row, then Enter", async () => {
    const state = { pointed: 0, lag: 2, selected: -1 };
    const sim = {
      // The pointer redraw lags two reads behind the digit.
      model: () => {
        if (state.lag > 0 && state.pointed !== 0) state.lag--;
        return previewModel(state.lag > 0 ? 0 : state.pointed);
      },
      press(key: string) {
        if (/^\d$/.test(key)) state.pointed = Number(key) - 1;
        if (key === "Enter") state.selected = state.pointed;
      },
    };
    const sent: Sent[] = [];
    expect(await previewSelectRecipe(simIO(sim, sent), previewModel(0), 2, "bound")).toEqual({ status: "sent" });
    expect(sent).toEqual([{ keys: ["2"], region: "bound" }, { keys: ["Enter"] }]);
    expect(state.selected).toBe(1);
  });

  it("a pointer that never moves sends no Enter", async () => {
    let reads = 0;
    const sim = {
      model: () => {
        reads++;
        return previewModel(0);
      },
      press: () => {},
    };
    const sent: Sent[] = [];
    expect(await previewSelectRecipe(simIO(sim, sent), previewModel(0), 3, undefined)).toEqual({ status: "changed" });
    expect(keysOf(sent)).toEqual(["3"]);
    expect(reads).toBe(POLL_ATTEMPTS);
  });

  it("another dialog after the digit sends no Enter", async () => {
    const sim = { model: () => previewModel(1, "a different dialog"), press: () => {} };
    const sent: Sent[] = [];
    expect(await previewSelectRecipe(simIO(sim, sent), previewModel(0), 2, undefined)).toEqual({ status: "changed" });
    expect(keysOf(sent)).toEqual(["2"]);
  });

  it("a refused first write stops the recipe", async () => {
    const sent: Sent[] = [];
    const io: RecipeIO<PreviewSelectModel> = {
      read: async () => previewModel(0),
      send: async (keys) => {
        sent.push({ keys });
        return { status: "changed" };
      },
      sleep: noSleep,
    };
    expect(await previewSelectRecipe(io, previewModel(0), 2, "bound")).toEqual({ status: "changed" });
    expect(sent).toHaveLength(1);
  });
});

describe("pollModel", () => {
  it("is ok, drifted on another dialog, drifted when the dialog is gone, timeout otherwise", async () => {
    const io = (seq: (number | null)[]) => {
      let i = 0;
      return { read: async () => seq[Math.min(i++, seq.length - 1)] ?? null, sleep: noSleep };
    };
    const same = (a: number, b: number) => Math.floor(a / 10) === Math.floor(b / 10);
    expect(await pollModel(io([10, 11, 12]), 10, (m) => m === 12, same)).toBe("ok");
    expect(await pollModel(io([10, 25]), 10, (m) => m === 12, same)).toBe("drifted");
    expect(await pollModel(io([null]), 10, (m) => m === 12, same)).toBe("drifted");
    expect(await pollModel(io([10]), 10, (m) => m === 12, same)).toBe("timeout");
  });
});

describe("dialog-recipes — leaf", () => {
  it("imports only the neutral model modules (the bridge imports it at runtime)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "..", "shared", "harness", "dialog-recipes.ts"), "utf8");
    const specs = [...src.matchAll(/^\s*import\s[^;]*?\sfrom\s+["']([^"']+)["']/gms)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec).toMatch(/^\.\/[a-z-]+-model$/);
  });
});
