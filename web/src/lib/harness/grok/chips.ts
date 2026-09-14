// Grok's IMAGE CHIP, read as evidence that a send containing an image path landed.
//
// The collie#34 guard (lib/actions.ts) only presses Enter once extractInputDraft shows what we
// typed. Grok Build rewrites an existing image-file path in the composer into a path-free chip
// `[Image #N]` (user-guide 03-keyboard-shortcuts.md). The box then holds a token, not the path,
// the generic substring match never fires, and the send stalls with the text sitting in the
// terminal — the report for attaching an image on a Grok pane.
//
// `#N` is a session-scoped counter we cannot predict, so a leftover chip looks exactly like ours.
// What IS checkable: the draft carries at least one chip, the send contained at least that many
// image paths (absolute, with a recognised raster extension — the only files Grok chips; other
// files stay as literal paths), and any literal text beside the chips appears in what we sent, in
// order. A `true` here fires the submit key, so anything inconsistent returns false.
//
// Ghost completions are a separate rewrite: Grok paints an italic gray tail after the cursor
// (`ESC[3m` + `38;2;128;128;128`, live 2026-09-07 pane w9C:p2). Those are stripped in
// extractInputDraft, not here.

const CHIP = /\[Image#\d+\]/g;
const IMAGE_PATH = /(?:[A-Za-z]:[\\/]|\/)[^\s]*\.(?:png|jpe?g|gif|webp)\b/gi;

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, "");
}

function countImagePaths(sent: string): number {
  const re = new RegExp(IMAGE_PATH.source, "gi");
  let n = 0;
  while (re.exec(sent) !== null) n++;
  return n;
}

function scan(stripped: string): { chips: number; fragments: string[] } {
  const re = new RegExp(CHIP.source, "g");
  const fragments: string[] = [];
  let chips = 0;
  let cursor = 0;
  for (let m = re.exec(stripped); m !== null; m = re.exec(stripped)) {
    chips++;
    if (m.index > cursor) fragments.push(stripped.slice(cursor, m.index));
    cursor = m.index + m[0].length;
  }
  if (cursor < stripped.length) fragments.push(stripped.slice(cursor));
  return { chips, fragments };
}

/**
 * Whether the input box's visible `draft` is evidence that `sent` reached it, given that Grok
 * rewrote image paths into `[Image #N]` chips. SUPPLEMENTAL: the reply guard consults this only
 * after its own literal-substring match has already failed.
 */
export function chipCarriesSend(sent: string, draft: string): boolean {
  const { chips, fragments } = scan(stripWhitespace(draft));
  if (chips === 0) return false;
  if (countImagePaths(sent) < chips) return false;

  const s = stripWhitespace(sent);
  let at = 0;
  for (const fragment of fragments) {
    const i = s.indexOf(fragment, at);
    if (i < 0) return false;
    at = i + fragment.length;
  }
  return true;
}

/**
 * Whether the draft is NOTHING but Grok image chip(s). The stranded-draft preview asks this before
 * offering "Take over": copying `[Image #1]` into the phone composer would type that string, not
 * the picture.
 */
export function isImageChipOnly(draft: string): boolean {
  const { chips, fragments } = scan(stripWhitespace(draft));
  return chips > 0 && fragments.length === 0;
}
