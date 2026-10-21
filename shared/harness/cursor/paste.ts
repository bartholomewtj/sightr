// Cursor's paste placeholder (spec 19). Same token shape as Claude's (harness/paste-token.ts), but
// Cursor's `+M lines` counts LINES: live-probed 2026-09-27, a 15-line paste showed `+15 lines` and a
// single long line `+1 lines`, so a token stands for M - 1 newlines.
import { pasteVerifier } from "../paste-token";

export const { pasteCarriesSend, isPastePlaceholderOnly } = pasteVerifier((m) => (m ?? 1) - 1);
