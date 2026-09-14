import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { containedRealpath } from "./journal/files.ts";

export interface ZipFile { real: string; name: string; size: number; dosTime: number; dosDate: number; data?: Uint8Array }
export interface ZipPlan { files: ZipFile[]; size: number }
export type ZipPlanFailure = "too-many" | "too-large";
type Refused = (name: string) => boolean;
type Child = { name: string; kind: "dir" | "file"; files: ZipFile[]; total: number };

export const SKIPPED_ZIP_ENTRY = "SIGHTR-SKIPPED.txt";

const text = new TextEncoder();
function u16(n: number): Uint8Array { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
function u32(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
function concat(...parts: Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; }
function dosDate(mtimeMs: number): { time: number; date: number } { const d = new Date(mtimeMs); const year = Math.max(1980, Math.min(2107, d.getFullYear())); return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; }
function local(name: Uint8Array, file: ZipFile, crc: number): Uint8Array { return concat(text.encode("PK\x03\x04"), u16(20), u16(0x0800), u16(0), u16(file.dosTime), u16(file.dosDate), u32(crc), u32(file.size), u32(file.size), u16(name.length), u16(0), name); }
function central(name: Uint8Array, file: ZipFile, crc: number, offset: number): Uint8Array { return concat(text.encode("PK\x01\x02"), u16(20), u16(20), u16(0x0800), u16(0), u16(file.dosTime), u16(file.dosDate), u32(crc), u32(file.size), u32(file.size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name); }
function archiveSize(files: ZipFile[]): number { return files.reduce((n, f) => n + 30 + text.encode(f.name).length + f.size + 46 + text.encode(f.name).length, 22); }

function skipNote(omitted: string[], capBytes: number, maxEntries: number): ZipFile {
  const mb = Math.round(capBytes / (1024 * 1024));
  const body = `Sightr left these out of the zip (over the ${mb} MB / ${maxEntries} file cap):\n\n${omitted.join("\n")}\n\nDownload a skipped folder on its own to try it separately.\n`;
  const data = text.encode(body);
  const dos = dosDate(Date.now());
  return { real: "", name: SKIPPED_ZIP_ENTRY, size: data.length, dosTime: dos.time, dosDate: dos.date, data };
}

/** Walk before producing any response body. The root is the work root, not just the folder being zipped. */
export async function collectZipEntries(folder: string, workRoot: string, refused: Refused, maxEntries: number, maxDepth: number, capBytes: number, prefix = basename(folder)): Promise<{ files: ZipFile[]; total: number } | ZipPlanFailure> {
  const files: ZipFile[] = []; let total = 0; const seen = new Set<string>();
  const queue: { real: string; rel: string[]; depth: number }[] = [{ real: folder, rel: [], depth: 0 }];
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current.real)) continue; seen.add(current.real);
    const entries = await readdir(current.real, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => Number(!a.isDirectory()) - Number(!b.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    for (const entry of entries.slice(0, maxEntries)) {
      if (refused(entry.name)) continue;
      const candidate = join(current.real, entry.name); const real = await containedRealpath(candidate, workRoot); if (!real) continue;
      const info = await stat(real).catch(() => null); if (!info) continue;
      const rel = [...current.rel, entry.name];
      if (info.isDirectory()) { if (current.depth < maxDepth) queue.push({ real, rel, depth: current.depth + 1 }); continue; }
      if (!info.isFile()) continue;
      const dos = dosDate(info.mtimeMs); files.push({ real, name: [prefix, ...rel].join("/"), size: info.size, dosTime: dos.time, dosDate: dos.date }); total += info.size;
      if (files.length > maxEntries) return "too-many";
      if (total > capBytes) return "too-large";
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { files, total };
}

/**
 * Zip the folder. Child directories or files that cannot fit the cap are omitted as a unit
 * (so a 150 MB dump next to a 0.4 MB app does not fail the whole download). Loose files that
 * still cannot fit after dropping every child directory → too-large / too-many.
 */
async function packChildren(folder: string, workRoot: string, refused: Refused, maxEntries: number, maxDepth: number, capBytes: number, prefix: string): Promise<{ files: ZipFile[]; omitted: string[] } | ZipPlanFailure> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const included: Child[] = [];
  const omitted: string[] = [];
  for (const entry of entries) {
    if (refused(entry.name) || entry.name === SKIPPED_ZIP_ENTRY) continue;
    const candidate = join(folder, entry.name); const real = await containedRealpath(candidate, workRoot); if (!real) continue;
    const info = await stat(real).catch(() => null); if (!info) continue;
    if (info.isFile()) {
      if (info.size > capBytes) { omitted.push(entry.name); continue; }
      const dos = dosDate(info.mtimeMs);
      included.push({ name: entry.name, kind: "file", files: [{ real, name: `${prefix}/${entry.name}`, size: info.size, dosTime: dos.time, dosDate: dos.date }], total: info.size });
      continue;
    }
    if (!info.isDirectory() || maxDepth < 1) continue;
    const sub = await collectZipEntries(real, workRoot, refused, maxEntries, maxDepth - 1, capBytes, `${prefix}/${entry.name}`);
    if (typeof sub === "string") { omitted.push(`${entry.name}/`); continue; }
    included.push({ name: entry.name, kind: "dir", files: sub.files, total: sub.total });
  }

  const bytes = () => included.reduce((n, c) => n + c.total, 0);
  const count = () => included.reduce((n, c) => n + c.files.length, 0);
  while (bytes() > capBytes || count() > maxEntries) {
    let fattest = -1;
    const overBytes = bytes() > capBytes;
    for (let i = 0; i < included.length; i++) {
      if (included[i]!.kind !== "dir") continue;
      if (fattest < 0) { fattest = i; continue; }
      const a = included[i]!; const b = included[fattest]!;
      if (overBytes ? a.total > b.total : a.files.length > b.files.length) fattest = i;
    }
    if (fattest < 0) return overBytes ? "too-large" : "too-many";
    const drop = included.splice(fattest, 1)[0]!;
    omitted.push(`${drop.name}/`);
  }
  return { files: included.flatMap((c) => c.files), omitted };
}

export async function planZip(folder: string, workRoot: string, refused: Refused, maxEntries: number, maxDepth: number, capBytes: number, prefix = basename(folder)): Promise<ZipPlan | ZipPlanFailure> {
  const packed = await packChildren(folder, workRoot, refused, maxEntries, maxDepth, capBytes, prefix);
  if (typeof packed === "string") return packed;
  const files = packed.files.slice();
  if (packed.omitted.length) {
    const note = skipNote(packed.omitted.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })), capBytes, maxEntries);
    note.name = `${prefix}/${SKIPPED_ZIP_ENTRY}`;
    files.push(note);
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { files, size: archiveSize(files) };
}

export function zipStream(plan: ZipPlan): ReadableStream<Uint8Array> {
  return new ReadableStream({ async start(controller) {
    const centralParts: Uint8Array[] = []; let offset = 0;
    try {
      for (const file of plan.files) {
        let data: Uint8Array;
        try { data = file.data ?? new Uint8Array(await Bun.file(file.real).arrayBuffer()); } catch { data = new Uint8Array(file.size); }
        if (data.length !== file.size) { const normalized = new Uint8Array(file.size); normalized.set(data.subarray(0, file.size)); data = normalized; }
        const name = text.encode(file.name); const crc = Bun.hash.crc32(data); const head = local(name, file, crc);
        controller.enqueue(head); controller.enqueue(data); centralParts.push(central(name, file, crc, offset)); offset += head.length + data.length;
      }
      const center = concat(...centralParts); controller.enqueue(center); controller.enqueue(concat(text.encode("PK\x05\x06"), u16(0), u16(0), u16(plan.files.length), u16(plan.files.length), u32(center.length), u32(offset), u16(0))); controller.close();
    } catch (error) { controller.error(error); }
  } });
}

export function zipName(root: string): string { return `${basename(root)}.zip`; }
