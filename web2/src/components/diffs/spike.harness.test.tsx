// T25 jsdom harness: renders the spike fixtures through the seam with whichever adapter `diffs-adapter`
// resolves to (SIGHTR_DIFFS), and writes commits, component renders and mounted DOM nodes. jsdom has no
// layout, so these numbers rank the candidates; the time thresholds are the browser pass's.
// Skipped unless SIGHTR_SPIKE_ADAPTER is set: `bun scripts/diff-spike.ts jsdom <adapter>` sets it (and
// SIGHTR_DIFFS), makes the fixtures if needed, and vitest.config.ts then loads the commit hook before React.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { adapterLines, countNodes, queryDeep, splitFiles, type SpikeFile } from "./spike/files.ts";
import { readCommitStats, resetCommitStats } from "./spike/hook.ts";
import { Panel, SELECTORS } from "./spike/Panel.tsx";

const adapter = process.env.SIGHTR_SPIKE_ADAPTER;
const out = process.env.SIGHTR_SPIKE_OUT;
const FIXTURES = resolve(import.meta.dirname, "../../../.spike-diffs");
const have = adapter && existsSync(resolve(FIXTURES, "large.patch"));

type Row = { adapter: string; fixture: string; files: number; lines: number; commitsFirst: number; commitsSettled: number; renders: number; nodes: number; highlighted: boolean; ms: number };
const size = (f: SpikeFile) => f.parsed.hunks.reduce((m, h) => m + h.lines.length, 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(have)("spike harness (jsdom)", () => {
  it(`measures ${adapter}`, async () => {
    class Observer { observe() {} unobserve() {} disconnect() {} }
    // jsdom has no layout: every window counts as on screen, so these node counts are the un-windowed upper bound.
    class Visible { constructor(private cb: (e: { isIntersecting: boolean }[]) => void) {} observe() { this.cb([{ isIntersecting: true }]); } unobserve() {} disconnect() {} }
    Object.assign(globalThis, { ResizeObserver: Observer, IntersectionObserver: Visible, __SIGHTR_DIFFS_NO_WORKER__: true });
    const load = (name: string): SpikeFile[] => splitFiles(readFileSync(resolve(FIXTURES, `${name}.patch`), "utf8"));
    const large = load("large");
    const worst = large.reduce((best, f, i) => (size(f) > size(large[best] as SpikeFile) ? i : best), 0);
    const cases: { name: string; files: SpikeFile[]; open: number[] }[] = [
      { name: "small (50 lines)", files: load("small"), open: [0] },
      { name: "medium (1,500 lines, 3 files)", files: load("medium"), open: [0, 1, 2] },
      { name: "large, first file open", files: large, open: [0] },
      { name: "large, 3,000-line file open", files: large, open: [worst] },
    ];

    const rows: Row[] = [];
    for (const c of cases) {
      const host = document.createElement("div");
      document.body.appendChild(host);
      resetCommitStats();
      const t0 = performance.now();
      const root = createRoot(host);
      root.render(<Panel files={c.files} open={c.open} wrap={true} />);
      const has = () => adapterLines(host).length > 0;
      for (let end = t0 + 30000; performance.now() < end && !has(); ) await sleep(5);
      const firstMs = Math.round(performance.now() - t0);
      const first = readCommitStats().commits;
      // Let highlighting and any worker or pool hand-off land, then check nothing keeps committing.
      await sleep(1500);
      const settled = readCommitStats();
      await sleep(500);
      expect(readCommitStats().commits).toBe(settled.commits); // no re-render loop
      rows.push({
        adapter: adapter as string,
        fixture: c.name,
        files: c.files.length,
        lines: c.open.reduce((n, i) => n + size(c.files[i] as SpikeFile), 0),
        commitsFirst: first,
        commitsSettled: settled.commits,
        renders: settled.renders,
        nodes: countNodes(host),
        highlighted: queryDeep(host, SELECTORS.highlighted).length > 0,
        ms: firstMs,
      });
      root.unmount();
      host.remove();
    }
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify({ adapter, rows }, null, 2));
    }
    expect(rows).toHaveLength(cases.length);
  }, 240000);
});
