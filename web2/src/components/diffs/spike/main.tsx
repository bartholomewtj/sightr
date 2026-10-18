// Sightr code (T25). The browser half of the diff-renderer spike: spike-diffs.html, built only with
// SIGHTR_DIFFS set. It mounts the fixtures through the seam in a phone-width scroller and prints timings
// on screen and on `window.__spikeResult`. Drive it with `?auto=<scenario>` (one cold run per page load) or
// from the console: `await __spike.run("large-first")`. Fixtures are fetched from ./fixtures/<name>.json
// ({ "patch": "..." }); copy them next to the built page (docs/specs/t3/README.md, re-measure line).
// T29 added `&sweep=1` (scroll the whole file top to bottom in 600 px steps and count what stays mounted) and gives
// the diffs the scroller as their observation root, as the Diff panel does (`&root=0` leaves it out, as T25 and T27 measured).
import "./hook.ts"; // before React: counts commits through the DevTools hook

import { createRoot, type Root } from "react-dom/client";

import "../../../index.css";
import { adapterLines, countNodes, queryDeep, splitFiles, type SpikeFile } from "./files.ts";
import { readCommitStats, resetCommitStats } from "./hook.ts";
import { DiffScrollRootContext } from "../DiffCodeView.tsx";
import { Panel, SELECTORS } from "./Panel.tsx";

type Scenario = "small" | "medium" | "large-first" | "large-worst";
const SCENARIOS: Scenario[] = ["small", "medium", "large-first", "large-worst"];

// Options come from the query, or from the hash: a service worker serves a precached page only for its exact URL.
const params = new URLSearchParams(location.search || location.hash.slice(1));

// ?worker=error|throw stands in for a worker that cannot start (the bridge CSP, a blocked or failed fetch): `error`
// raises an error event on the new Worker as the browser does, `throw` throws from the constructor.
const workerMode = params.get("worker");
if (workerMode === "error" || workerMode === "throw") {
  class BrokenWorker extends EventTarget {
    constructor() {
      super();
      if (workerMode === "throw") throw new DOMException("worker blocked", "SecurityError");
      setTimeout(() => this.dispatchEvent(new ErrorEvent("error", { message: "worker blocked" })), 0);
    }
    postMessage() {}
    terminate() {}
  }
  (window as unknown as { Worker: unknown }).Worker = BrokenWorker;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
const heap = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
const gc = async () => {
  const g = (window as unknown as { gc?: () => void }).gc;
  for (let i = 0; i < 3; i++) { g?.(); await sleep(50); }
};

async function fixture(name: string): Promise<SpikeFile[]> {
  const res = await fetch(`./fixtures/${name}.json`);
  if (!res.ok) throw new Error(`fixture ${name}: ${res.status}`);
  return splitFiles(((await res.json()) as { patch: string }).patch);
}
const weight = (f: SpikeFile) => f.parsed.hunks.reduce((n, h) => n + h.lines.length, 0);

const longTasks: number[] = [];
try {
  new PerformanceObserver((list) => list.getEntries().forEach((e) => longTasks.push(e.duration))).observe({ type: "longtask", buffered: true });
} catch { /* no long-task support */ }

// CSP violations and console errors, from the first line of the page (the worker/CSP row reads them).
const problems: { kind: string; detail: string }[] = [];
document.addEventListener("securitypolicyviolation", (e) => problems.push({ kind: "csp", detail: `${e.violatedDirective} ${e.blockedURI}` }));
window.addEventListener("error", (e) => problems.push({ kind: "error", detail: String(e.message) }));
window.addEventListener("unhandledrejection", (e) => problems.push({ kind: "rejection", detail: String((e.reason as Error)?.message ?? e.reason) }));
const origError = console.error;
console.error = (...a: unknown[]) => {
  problems.push({ kind: "console.error", detail: a.map((x) => (x instanceof Error ? x.message : String(x))).join(" ").slice(0, 200) });
  origError(...a);
};

function resources() {
  return performance
    .getEntriesByType("resource")
    .map((e) => e as PerformanceResourceTiming)
    .filter((e) => /\.(js|mjs)(\?|$)/.test(e.name) && !/spike-diffs/.test(e.name))
    .map((e) => ({ name: e.name.replace(location.origin, ""), encoded: e.encodedBodySize, decoded: e.decodedBodySize, transfer: e.transferSize, ms: Math.round(e.duration) }));
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let frames: number[] = [];
let framing = false;

function scroller(): HTMLElement {
  let el = document.getElementById("scroller");
  if (!el) {
    el = document.createElement("div");
    el.id = "scroller";
    el.style.cssText = "height:100dvh;overflow:auto;overscroll-behavior:contain;background:var(--background)";
    document.getElementById("root")?.replaceChildren();
    document.getElementById("root")?.appendChild(el);
  }
  return el;
}

async function preload() {
  const t = performance.now();
  await import("diffs-adapter");
  return Math.round(performance.now() - t);
}

async function mount(s: Scenario) {
  const need = s === "small" ? "small" : s === "medium" ? "medium" : "large";
  const files = await fixture(need);
  const worst = files.reduce((b, f, i) => (weight(f) > weight(files[b] as SpikeFile) ? i : b), 0);
  const open = s === "medium" ? files.map((_, i) => i) : s === "large-worst" ? [worst] : [0];
  return { files, open };
}

/**
 * Mount a one-file panel and wait for the adapter's own lines, so the measured render below does not pay for
 * React's first-suspend (Suspense holds a revealed fallback ~300 ms) or, for pierre, the worker pool booting.
 * `warm=0` skips it: that is the first diff opened in a session.
 */
async function warmUp() {
  const files = await fixture("small");
  const el = document.createElement("div");
  document.body.appendChild(el);
  const r = createRoot(el);
  r.render(<Panel files={files} open={[0]} wrap={true} />);
  for (let end = performance.now() + 30000; performance.now() < end && adapterLines(el).length === 0; ) await sleep(20);
  await sleep(1000);
  r.unmount();
  el.remove();
}

/**
 * Scroll the scroller from top to bottom, `stepPx` every `stepMs`, and watch what stays mounted: the most nodes and
 * windows at any step, the long tasks while it moves, and the heap at the end. Ends once the bottom has been reached twice.
 */
async function sweep(el: HTMLElement, stepPx = 600, stepMs = 120, maxSteps = 6000) {
  el.scrollTop = 0;
  await sleep(300);
  longTasks.length = 0;
  let steps = 0;
  let maxNodes = 0;
  let maxWindows = 0;
  let atBottom = 0;
  let windowsTotal = 0;
  const t0 = performance.now();
  for (; steps < maxSteps && atBottom < 2; steps++) {
    const before = el.scrollTop;
    el.scrollTop = before + stepPx;
    await sleep(stepMs);
    maxNodes = Math.max(maxNodes, countNodes(el));
    maxWindows = Math.max(maxWindows, el.querySelectorAll("[data-diff-window=on]").length);
    windowsTotal = el.querySelectorAll("[data-diff-window]").length;
    atBottom = el.scrollTop === before || el.scrollTop + el.clientHeight >= el.scrollHeight - 2 ? atBottom + 1 : 0;
  }
  await sleep(600); // let the last long-task entries arrive
  const tasks = longTasks.slice();
  return {
    steps, seconds: +((performance.now() - t0) / 1000).toFixed(1), stepPx, stepMs, scrolledPx: Math.round(el.scrollTop), scrollHeightPx: el.scrollHeight,
    windowsTotal, maxWindowsMounted: maxWindows, maxNodes, nodesAtEnd: countNodes(el),
    longTasks: tasks.length, over100: tasks.filter((t) => t > 100).length, over250: tasks.filter((t) => t > 250).length, maxLongTaskMs: Math.round(Math.max(0, ...tasks)),
    heapAtEndMB: heap() === null ? null : +((heap() as number) / 1e6).toFixed(1),
  };
}

async function run(s: Scenario, opts: { wrap?: boolean; keep?: boolean; actions?: boolean; layout?: "stacked" | "split"; warm?: boolean; sweep?: boolean; root?: boolean } = {}) {
  const wrap = opts.wrap ?? true;
  const { files, open } = await mount(s);
  const chunkMs = await preload();
  if (opts.warm !== false) await warmUp();
  await unmount();
  await gc();
  const heapBefore = heap();
  longTasks.length = 0;
  resetCommitStats();
  host = scroller();
  root = createRoot(host);
  const t0 = performance.now();
  root.render(
    <DiffScrollRootContext value={opts.root === false ? null : host}>
      <Panel files={files} open={open} wrap={wrap} actions={opts.actions} layout={opts.layout} />
    </DiffScrollRootContext>,
  );
  const has = () => adapterLines(host as HTMLElement).length > 0;
  const anyLine = () => queryDeep(host as HTMLElement, "[data-diff-line]").length > 0;
  const hl = () => queryDeep(host as HTMLElement, SELECTORS.highlighted).length > 0;
  let fallbackMs: number | null = null;
  let contentMs: number | null = null;
  let paintMs: number | null = null;
  let highlightMs: number | null = null;
  const deadline = t0 + 60000;
  // Wait for the lines, then up to 8 s more for highlighting (an adapter with none, or a file with no grammar, never gets it).
  const done = () => {
    const now = performance.now() - t0;
    return contentMs !== null ? highlightMs !== null || now >= contentMs + 8000 : fallbackMs !== null && now >= fallbackMs + 12000;
  };
  while (performance.now() < deadline && !done()) {
    if (fallbackMs === null && anyLine()) fallbackMs = Math.round(performance.now() - t0);
    if (contentMs === null && has()) {
      contentMs = Math.round(performance.now() - t0);
      await frame();
      await frame();
      paintMs = Math.round(performance.now() - t0);
    }
    if (highlightMs === null && hl()) highlightMs = Math.round(performance.now() - t0);
    await sleep(10);
  }
  const first = readCommitStats().commits;
  await sleep(1500);
  const settled = readCommitStats();
  await sleep(500);
  const stable = readCommitStats().commits === settled.commits;
  const heapAfter = heap();
  const nodes = countNodes(host);
  const lines = open.reduce((n, i) => n + weight(files[i] as SpikeFile), 0);
  const gutter = queryDeep(host, "[data-diff-gutter], [data-gutter] [data-column-number]")[0];
  const code = adapterLines(host)[0];
  const box = gutter?.getBoundingClientRect();
  const touch = {
    gutter: gutter ? { w: Math.round((box?.width ?? 0) * 10) / 10, h: Math.round((box?.height ?? 0) * 10) / 10, hit: hitArea(gutter) } : null,
    selectable: code ? getComputedStyle(code).userSelect !== "none" : null,
    pageHScroll: document.documentElement.scrollWidth > innerWidth,
    scrollerHScroll: host.scrollWidth > host.clientWidth,
  };
  const result: Record<string, unknown> = {
    touch,
    swControlled: !!navigator.serviceWorker?.controller,
    problems: problems.slice(), coarse: matchMedia("(pointer: coarse)").matches, dpr: devicePixelRatio, viewport: `${innerWidth}x${innerHeight}`, resources: resources(),
    scenario: s, wrap, lines, files: files.length, open: open.length, chunkMs, fallbackMs, contentMs, paintMs, highlightMs,
    longTasks: longTasks.length, maxLongTaskMs: Math.round(Math.max(0, ...longTasks)), commitsFirst: first, commitsSettled: settled.commits, renders: settled.renders, stable,
    nodes, heapBeforeMB: heapBefore === null ? null : +(heapBefore / 1e6).toFixed(1), heapAfterMB: heapAfter === null ? null : +((heapAfter - (heapBefore ?? 0)) / 1e6).toFixed(1),
  };
  if (opts.sweep) result.sweep = await sweep(host);
  if (!opts.keep) {
    await unmount();
    await gc();
    const after = heap();
    result.heapAfterUnmountMB = after === null || heapBefore === null ? null : +((after - heapBefore) / 1e6).toFixed(1);
  }
  return result;
}

async function unmount() {
  root?.unmount();
  root = null;
  host?.replaceChildren();
  await sleep(50);
}

/** Frame intervals while an external fling (CDP touch gestures) drives the scroller. */
function startFrames() {
  frames = [];
  framing = true;
  let last = performance.now();
  const tick = (now: number) => {
    if (!framing) return;
    frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function stopFrames() {
  framing = false;
  const sorted = [...frames].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const total = frames.reduce((a, b) => a + b, 0);
  // A frame is dropped when its interval is over 1.5 vsyncs (16.7 ms): 25 ms.
  return { frames: frames.length, seconds: +(total / 1000).toFixed(2), p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +Math.max(0, ...frames).toFixed(1), over20Pct: +((100 * frames.filter((f) => f > 20).length) / Math.max(1, frames.length)).toFixed(1), droppedPct: +((100 * frames.filter((f) => f > 25).length) / Math.max(1, frames.length)).toFixed(1), scrolled: Math.round(document.getElementById("scroller")?.scrollTop ?? 0) };
}

const api = { run, unmount, startFrames, stopFrames, heap, gc, scenarios: SCENARIOS, hitArea };
(window as unknown as { __spike: typeof api }).__spike = api;

/** The tappable area of an element: its box plus an absolutely-positioned ::after reaching past it. */
function hitArea(el: Element) {
  const r = el.getBoundingClientRect();
  const a = getComputedStyle(el, "::after");
  if (a.content === "none" || a.position !== "absolute") return { w: r.width, h: r.height };
  const px = (v: string) => (v === "auto" ? 0 : parseFloat(v));
  return { w: r.width + Math.abs(px(a.left)) + Math.abs(px(a.right)), h: r.height + Math.abs(px(a.top)) + Math.abs(px(a.bottom)) };
}

function show(value: unknown) {
  (window as unknown as { __spikeResult: unknown }).__spikeResult = value;
  const pre = document.getElementById("spike-out") ?? Object.assign(document.createElement("pre"), { id: "spike-out" });
  pre.setAttribute("style", "position:fixed;right:0;bottom:0;max-width:60%;max-height:40%;overflow:auto;margin:0;padding:4px;background:#000c;color:#9f9;font:10px/1.2 monospace;z-index:99");
  pre.textContent = JSON.stringify(value, null, 1);
  document.body.appendChild(pre);
}

const auto = params.get("auto") as Scenario | null;
if (auto && SCENARIOS.includes(auto)) {
  run(auto, { wrap: params.get("wrap") !== "0", keep: params.get("keep") === "1", actions: params.get("actions") === "1", warm: params.get("warm") !== "0", sweep: params.get("sweep") === "1", root: params.get("root") !== "0", layout: params.get("layout") === "split" ? "split" : "stacked" }).then(show, (e: Error) => show({ error: e.message }));
} else {
  scroller().textContent = "Diff spike: run __spike.run('small' | 'medium' | 'large-first' | 'large-worst') or open with ?auto=<scenario>.";
}
