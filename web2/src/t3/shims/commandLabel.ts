/**
 * Stand-in for T3 Code's `@t3tools/client-runtime/work-log/command-label`
 * (packages/client-runtime/src/work-log/commandLabel.ts @ e3b35d1b, MIT). Upstream is a 1.4k-line shell
 * tokenizer that unwraps `bash -lc "…"` and finds the program behind env/sudo prefixes. Herdr journals
 * already record the command the agent typed, so the first word is enough here.
 */

// Escape bytes and other control characters render as invisible gaps; display shows them as Unicode
// control pictures (ESC becomes ␛) instead. Same as upstream.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export function withVisibleControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTERS, (character) =>
    character === "\u007f" ? "␡" : String.fromCharCode(0x2400 + character.charCodeAt(0)),
  );
}

export function commandDisplayText(command: string): string {
  return withVisibleControlCharacters(command.trim());
}

/** The program a command runs: its first word, without a directory or `.exe`. */
export function commandProgramName(command: string): string | null {
  const first = command.trim().split(/\s+/u)[0];
  if (!first) return null;
  const name = first.replace(/^["']|["']$/gu, "").split(/[\\/]/u).at(-1)?.replace(/\.exe$/iu, "");
  return name || null;
}
