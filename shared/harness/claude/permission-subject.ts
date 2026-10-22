// What a Claude permission dialog asks about: the tool and its target, read from the dialog's own
// subject block between its top `───` rule and the question. The question itself is generic ("Do you
// want to proceed?"), so without this the phone card cannot say WHAT it is approving.
//
//   ─────────────────────────────            ─────────────────────────────
//    Bash command                              Read file                    1 of 2
//                                             ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//      git status                              Read(C:\…\notes.md)
//      Show the working tree (dim)            ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//                                              Do you want to proceed?
//    This command requires approval
//    Do you want to proceed?
//
// Claude 2.1.302 also boxes a command under its description (`│ git status` between dashed rules);
// that box is the target and the description the detail.
// Measured on Claude Code 2.1.302 (fixtures/permission-subject, fixtures/panes/claude--permission-*).
// Pure and leaf-only (the bridge imports it through dialog-kit.ts): no `react`, no `@shared`.

import { isBlank, lineText, type StyledLine } from "../blocks";
import { isBoxBorder, isHorizontalRule } from "./markers";

/** The tool and target of a permission dialog. Shown on the approval card only. */
export interface PermissionSubject {
  /** What the tool does, in the card's words ("Run command", "Read file", "Edit file"). */
  title: string;
  /** The command or the path, as the dialog shows it (a wrapped command keeps its line breaks). */
  target?: string;
  /** The dialog's own dim description under the command ("Show the working tree"). */
  detail?: string;
}

/** How far above the question the dialog's top rule may sit. */
const LOOKBACK = 120;
/** The most target lines kept (a long heredoc is cut; the terminal has the rest). */
export const SUBJECT_MAX_LINES = 40;
/** The most target characters kept. */
export const SUBJECT_MAX_CHARS = 4000;

/** Claude's headings, in the card's verb-first words. Others pass through as Claude wrote them. */
const TITLES: Record<string, string> = {
  "bash command": "Run command",
  "powershell command": "Run command",
};

/** A heading's trailing "1 of 2" (parallel tool calls waiting in turn). */
const COUNTER = /\s{2,}\d+\s+of\s+\d+$/;
/** A tool-call echo whose argument is the target: `Read(C:\x\notes.md)`. */
const CALL = /^[A-Z][A-Za-z]*\(([\s\S]+)\)$/;
/** A boxed command's gutter: `│ ` before each of its lines. */
const GUTTER = /^\s*│ ?/;
/** Lines that are the dialog's own boilerplate, never the target. */
const BOILERPLATE = /^(this command requires approval|permission rule .* requires confirmation)/i;

function isDashedRule(text: string): boolean {
  return isHorizontalRule(text) && !isBoxBorder(text);
}

/** Dim text: the SGR dim flag or a grey truecolour, on every visible segment. */
function isDim(line: StyledLine): boolean {
  const visible = line.segments.filter((s) => s.text.trim() !== "");
  if (visible.length === 0) return false;
  return visible.every((s) => {
    if (s.dim) return true;
    const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(s.fg ?? "");
    return m !== null && m[1] === m[2] && m[2] === m[3] && Number(m[1]) < 200;
  });
}

function cap(text: string): string {
  return text.length > SUBJECT_MAX_CHARS ? `${text.slice(0, SUBJECT_MAX_CHARS - 1)}…` : text;
}

/**
 * The subject of the permission dialog whose question line reads `question`, or null when the block
 * above the question is not a recognisable subject (no top rule in reach, no heading).
 */
export function claudePermissionSubject(lines: readonly StyledLine[], question: string): PermissionSubject | null {
  const texts = lines.map(lineText);
  let q = -1;
  for (let i = texts.length - 1; i >= 0; i--) {
    if (texts[i]!.trim() === question) {
      q = i;
      break;
    }
  }
  if (q < 0) return null;
  let top = -1;
  for (let i = q - 1; i >= Math.max(0, q - LOOKBACK); i--) {
    const t = texts[i]!;
    if (isBoxBorder(t) && isHorizontalRule(t) && (i === 0 || isBlank(texts[i - 1]!))) {
      top = i;
      break;
    }
  }
  if (top < 0) return null;

  let i = top + 1;
  while (i < q && isBlank(texts[i]!)) i++;
  if (i >= q) return null;
  const heading = texts[i]!.trim().replace(COUNTER, "").trim();
  if (heading === "" || isDashedRule(heading)) return null;
  const title = TITLES[heading.toLowerCase()] ?? heading;
  i++;

  // Claude 2.1.302's boxed layout: the dim description under the heading, then the command in a
  // dashed box with a `│ ` gutter on each of its lines.
  let end = i;
  while (end < q && !BOILERPLATE.test(texts[end]!.trim())) end++;
  const boxed = texts.slice(i, end).findIndex((t) => GUTTER.test(t));
  if (boxed >= 0) {
    const g = i + boxed;
    const command: string[] = [];
    for (let k = g; k < end && GUTTER.test(texts[k]!) && command.length < SUBJECT_MAX_LINES; k++) {
      command.push(texts[k]!.replace(GUTTER, "").trimEnd());
    }
    const about = texts.slice(i, g).filter((t, k) => !isBlank(t) && !isDashedRule(t) && isDim(lines[i + k]!));
    const commandText = command.join("\n").trim();
    return {
      title,
      ...(commandText !== "" ? { target: cap(commandText) } : {}),
      ...(about.length > 0 ? { detail: about.map((t) => t.trim()).join(" ") } : {}),
    };
  }

  // The target: the first run of lines after the heading (dashed rules and blanks skipped before
  // it), up to a blank, a dashed rule or the dim description. Its first line may itself be dim (an
  // edit's file name is), so dimness only ends the run once it has started.
  while (i < q && (isBlank(texts[i]!) || isDashedRule(texts[i]!))) i++;
  const target: string[] = [];
  for (; i < q && target.length < SUBJECT_MAX_LINES; i++) {
    const t = texts[i]!;
    if (isBlank(t) || isDashedRule(t) || BOILERPLATE.test(t.trim())) break;
    if (target.length > 0 && isDim(lines[i]!) && !isDim(lines[i - 1]!)) break;
    target.push(t.trim());
  }
  const detail: string[] = [];
  for (; i < q && detail.length < 3; i++) {
    const t = texts[i]!;
    if (isBlank(t) || isDashedRule(t) || !isDim(lines[i]!)) break;
    detail.push(t.trim());
  }

  let targetText = target.join("\n");
  // `Read(C:\…\notes.md)`: the argument is the target; a long one wrapped, so rejoin it unbroken.
  const call = CALL.exec(target.join(""));
  if (call) targetText = call[1]!.trim();
  return {
    title,
    ...(targetText !== "" ? { target: cap(targetText) } : {}),
    ...(detail.length > 0 ? { detail: detail.join(" ") } : {}),
  };
}
