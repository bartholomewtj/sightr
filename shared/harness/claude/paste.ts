// Claude's paste placeholder: the grammar is shared (harness/paste-token.ts); Claude's `+M lines`
// counts newlines, and a single-line paste has no count at all.
import { pasteVerifier } from "../paste-token";

export const { pasteCarriesSend, isPastePlaceholderOnly } = pasteVerifier((m) => m ?? 0);
