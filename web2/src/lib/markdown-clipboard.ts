// Adapted from T3 Code apps/web/src/markdown-clipboard.ts @ 688ee52f0e8f (MIT, see THIRD_PARTY.md).
// Only the table serializers are ported: a rendered table copied as Markdown (`| a | b |`) or as CSV.
// T3's code-block, math, mermaid and whole-document serializers stay upstream — Sightr copies a
// message's text from the model output, not from the rendered DOM, so nothing else needs them.
// The Markdown one walks the rendered table (so inline code, emphasis and links inside a cell survive
// as Markdown); the CSV one takes each cell's text, quoted the way a spreadsheet expects.

/** Elements that are chrome, not content: a cell's copy button or a decorative icon adds nothing. */
const NON_CONTENT_TAGS = new Set(["BUTTON", "INPUT", "SCRIPT", "STYLE", "TEMPLATE"]);

function isNonContent(element: Element): boolean {
  if (NON_CONTENT_TAGS.has(element.tagName)) return true;
  if (element.localName === "svg") return true;
  return element.getAttribute("aria-hidden") === "true";
}

function wrapInlineMarker(content: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content);
  const core = match?.[2] ?? "";
  if (!core) return content;
  return `${match?.[1] ?? ""}${marker}${core}${marker}${match?.[3] ?? ""}`;
}

/** Inline code needs a fence longer than the longest backtick run it contains. */
function wrapInlineCode(code: string): string {
  const longestRun = [...(code.match(/`+/g) ?? [])].reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(1, longestRun + (longestRun > 0 ? 1 : 0)));
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

function serializeAnchor(anchor: Element): string {
  const content = serializeChildren(anchor);
  const href = anchor.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(href)) return content;
  const label = content.trim();
  if (!label) return "";
  if (label === href) return href;
  return `[${label}](${href})`;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;
  if (isNonContent(element)) return "";

  switch (element.tagName) {
    case "BR":
      return "\n";
    case "P": {
      const content = serializeChildren(element).trim();
      return content ? `${content} ` : "";
    }
    case "CODE":
      return wrapInlineCode(element.textContent ?? "");
    case "STRONG":
    case "B":
      return wrapInlineMarker(serializeChildren(element), "**");
    case "EM":
    case "I":
      return wrapInlineMarker(serializeChildren(element), "*");
    case "DEL":
    case "S":
      return wrapInlineMarker(serializeChildren(element), "~~");
    case "A":
      return serializeAnchor(element);
    case "IMG": {
      const alt = element.getAttribute("alt") ?? "";
      const src = element.getAttribute("src") ?? "";
      return alt && src ? `![${alt}](${src})` : "";
    }
    default:
      return serializeChildren(element);
  }
}

function serializeChildren(node: Node): string {
  let out = "";
  for (const child of node.childNodes) out += serializeNode(child);
  return out;
}

/** One cell as Markdown: on one line, with pipes escaped so they cannot split the row. */
function serializeTableCell(cell: Element): string {
  return serializeChildren(cell).replace(/\n+/g, " ").trim().replaceAll("|", "\\|");
}

function tableSeparatorFor(headerCells: Element[]): string {
  const markers = headerCells.map((cell) => {
    const align = (cell as HTMLElement).style?.textAlign ?? cell.getAttribute("align") ?? "";
    if (align === "center") return ":---:";
    if (align === "right") return "---:";
    return "---";
  });
  return `| ${markers.join(" | ")} |`;
}

/** The table's own rows, in document order: a `<tr>` directly under the table counts as a header. */
function tableRows(table: HTMLTableElement): Element[] {
  return [...table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr")];
}

function rowCells(row: Element): Element[] {
  return [...row.children].filter((cell) => cell.tagName === "TH" || cell.tagName === "TD");
}

/** The whole rendered table as a GFM table, without a trailing newline. */
export function serializeTableElementToMarkdown(table: HTMLTableElement): string {
  const rows = tableRows(table);
  const lines: string[] = [];
  let emittedSeparator = false;
  for (const row of rows) {
    const cells = rowCells(row);
    if (cells.length === 0) continue;
    lines.push(`| ${cells.map((cell) => serializeTableCell(cell)).join(" | ")} |`);
    // Markdown wants exactly one separator row, under whichever row came first.
    if (!emittedSeparator) {
      lines.push(tableSeparatorFor(cells));
      emittedSeparator = true;
    }
  }
  return lines.join("\n");
}

function csvCell(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return /[",\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

/** The whole rendered table as CSV (comma, `"` quoting, one row per line), no header special-casing. */
export function serializeTableElementToCsv(table: HTMLTableElement): string {
  const lines: string[] = [];
  for (const row of tableRows(table)) {
    const cells = rowCells(row);
    if (cells.length === 0) continue;
    lines.push(cells.map((cell) => csvCell(cell.textContent ?? "")).join(","));
  }
  return lines.join("\n");
}
