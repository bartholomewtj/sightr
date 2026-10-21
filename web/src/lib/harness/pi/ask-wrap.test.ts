import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it, expect } from "vitest";
import { freeTextModel } from "../dialog-kit";
const raw = readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "live-free-text", "pi--ask-wizard-editing.txt"), "utf8");
// Bart, 21 Oct: a long typed answer wrapped in Pi's editor, the space at the wrap was read as nothing,
// the bridge saw "verycomplex" instead of his text and never pressed Enter.
it("an editor answer that wraps keeps the space at the wrap", () => {
  const text = "I want pi sonnet subs for most, opus only for very complex parts, hand done for the rest";
  // The fixture's rule is 64 wide, so a non-final line is at most 63 columns.
  const l1 = "I want pi sonnet subs for most, opus only for very ";
  const l2 = "complex parts, hand done for the rest";
  const out = raw.replace(/ (\x1b\[0m)\x1b\[7m \x1b\[0m {10,}\r/, ` $1${l1.padEnd(63)}\r\n $1${l2}\x1b[7m \x1b[0m\r`);
  expect(out).not.toBe(raw);
  const m = freeTextModel("pi", out);
  expect(m?.text).toBe(text);
});
