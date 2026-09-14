import { lineText, rstrip } from "../scan";

export const RULE = /^─{20,}$/;
export const HELP_SINGLE = /^\s*↑↓ navigate • Enter select • Esc cancel$/;
export const HELP_MULTI = /^\s*Tab\/←→ navigate • ↑↓ select • Enter confirm • Esc cancel$/;
export const OPTION = /^(> |  )(\d+)\. (.*)$/;
export const DESCRIPTION = /^ {5}\S/;
export const LABEL_WRAP = /^ {2}(?! )\S/;
export const OTHER_LABEL = "Type something.";
export const STATS = /(?:\d+(?:\.\d+)?%|\?)\/\d+(?:\.\d+)?[kKmM]\b/;
export const TAB_BAR = /^\s*←\s(.*)\s✓ Submit\s+→$/;

export { lineText, rstrip };
