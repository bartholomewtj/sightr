// Adapted from T3 Code apps/web/src/components/chat/MermaidDiagram.tsx @ 688ee52f0e8f (MIT, see
// THIRD_PARTY.md). Pruned to what a read-only chat needs: no `markdown-clipboard` provenance, no
// expand-to-image export (and so no blob URLs, no computed-style copying), and no KaTeX math
// resolver — a `$$…$$` label renders as its own text. Sightr has no DOMPurify, so the SVG string is
// sanitized here: pele escapes the labels it draws and links/images are off, and this drops the
// elements and attributes that could still navigate or run anything.
//
// Loading is a plain Suspense suspend (a tracked promise thrown from render): the pele core chunk,
// then the detected diagram type's own chunk. The caller's `<Suspense>` shows the code block while
// the diagram is on its way and its error boundary shows the same if anything throws (no type, a
// failed chunk, a bad source, a parsererror). A failure therefore renders null here — the fallback
// belongs to the caller. (React 19's `use()` would be the modern spelling, but it does not resume a
// suspended tree under this repo's jsdom tests; a thrown promise does, in both environments.)
import { useMemo } from "react";

type Pele = typeof import("pele/lazy");
type DiagramType = import("pele/lazy").DiagramType;

let coreLoad: Promise<Pele> | null = null;
// Each diagram type is its own chunk, so a chat with one flowchart loads only the flowchart parser.
const diagramLoads = new Map<DiagramType, Promise<boolean>>();

function loadCore(): Promise<Pele> {
  if (!coreLoad) {
    const load = import("pele/lazy").then((module) => module);
    // A rejected module stays rejected in the ESM cache; forget it so a remount tries again.
    void load.catch(() => {
      if (coreLoad === load) coreLoad = null;
    });
    coreLoad = load;
  }
  return coreLoad;
}

function loadDiagramType(pele: Pele, type: DiagramType): Promise<boolean> {
  let load = diagramLoads.get(type);
  if (!load) {
    load = pele.load(type);
    void load.catch(() => {
      if (diagramLoads.get(type) === load) diagramLoads.delete(type);
    });
    diagramLoads.set(type, load);
  }
  return load;
}

function detectDiagramType(pele: Pele, source: string): DiagramType | null {
  try {
    return pele.detectType(source);
  } catch {
    return null;
  }
}

/** Elements pele never needs for a read-only diagram: navigation, scripts, styling, remote images. */
const FORBIDDEN_TAGS = new Set([
  "a",
  "animate",
  "embed",
  "foreignobject",
  "iframe",
  "image",
  "object",
  "script",
  "style",
]);
const FORBIDDEN_ATTRIBUTES = new Set(["href", "src", "srcset", "xlink:href"]);

function scrub(element: Element): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (FORBIDDEN_ATTRIBUTES.has(name) || name.startsWith("on")) {
      element.removeAttribute(attribute.name);
    }
  }
  for (const child of [...element.children]) {
    if (FORBIDDEN_TAGS.has(child.tagName.toLowerCase())) {
      child.remove();
      continue;
    }
    scrub(child);
  }
}

/** Pele's SVG markup with the parts that could act on the page removed; "" when it is not SVG. */
function sanitizeSvgMarkup(svg: string): string {
  if (typeof DOMParser === "undefined") return "";
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return "";
  if (parsed.querySelector("parsererror")) return "";
  scrub(root);
  return root.outerHTML;
}

type TrackedPromise<T> = Promise<T> & { status?: "pending" | "fulfilled" | "rejected"; value?: T };

/** Suspend on `promise` (React's classic pattern): throw while pending, rethrow a rejection. */
function suspendOn<T>(promise: Promise<T>): T {
  const tracked = promise as TrackedPromise<T>;
  if (tracked.status === undefined) {
    tracked.status = "pending";
    tracked.then(
      (value) => {
        tracked.status = "fulfilled";
        tracked.value = value;
      },
      () => {
        tracked.status = "rejected";
      },
    );
  }
  if (tracked.status === "pending") throw tracked;
  if (tracked.status === "rejected") throw new Error("the diagram renderer failed to load");
  return tracked.value as T;
}

/** A mermaid source rendered by pele. Throw-or-suspend only: the caller owns the fallback. */
export function MermaidDiagram({ source }: { source: string }) {
  const pele = suspendOn(loadCore());
  const trimmed = source.trim();
  const type = detectDiagramType(pele, trimmed);
  // The type's own chunk has to be registered before anything can be rendered.
  const ready = type !== null && suspendOn(loadDiagramType(pele, type));
  if (type === null || !ready) {
    throw new Error(type === null ? "pele does not know this diagram" : "the renderer did not load");
  }
  const markup = useMemo(
    () =>
      sanitizeSvgMarkup(
        pele.render(trimmed, { links: false, images: false, autoDirection: false }).svg,
      ),
    [pele, trimmed],
  );
  if (!markup) throw new Error(`pele could not render this ${type} diagram`);

  return (
    <div
      className="chat-markdown-mermaid max-w-full overflow-x-auto"
      data-markdown-mermaid=""
      // Pele's own SVG, scrubbed above; no author HTML reaches this node.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
