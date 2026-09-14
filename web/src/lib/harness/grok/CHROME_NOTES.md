# Grok composer — send-guard rewrites

The reply path types into Grok, then presses Enter only if `extractInputDraft` still shows what we
sent (`lib/actions.ts` `sendGuardedReply`). Two Grok rewrites make that match fail. Both are on
the chrome/reply path, not a dialog lift.

## Image chip `[Image #N]`

Grok Build turns an existing image-file path in the composer into a path-free chip `[Image #N]`
(Grok user-guide *Keyboard Shortcuts* → Image Paste: "Image chips are always path-free").
Sightr's Attach file uploads to `<stateDir>/uploads/` and puts that absolute path in the
message. After `pane.send_text`, the box holds the chip, not the path.

`chipCarriesSend` (`chips.ts`) treats the chip as send evidence when:

- the draft has at least one `[Image #N]`
- the send contained at least that many absolute image paths (png / jpeg / gif / webp)
- any literal text beside the chips appears in the send, in order

A leftover chip does not vouch for a send with no image path. `#N` is a session counter we cannot
predict.

No live composer capture of the chip yet. The matcher is unit-tested; a pane.read of a stalled
image send would pin the on-screen shape.

## Italic ghost completion

Live 2026-09-07, pane `w9C:p2`, Grok Build 1.0.13. Empty composer showing a history suggestion:

- prompt glyph `>` is not italic
- suggestion text (`continue`) is `ESC[3m` + `38;2;128;128;128`
- hint bar starts `Tab/→:accept suggestion` (already chrome in `isComposerHint`)

A typed URL or path gets the same italic tail after the cursor. `extractInputDraft` drops italic
segments, so the ghost is not part of the verified draft. An empty box whose only inner text is
italic is not a stranded draft.

Typed draft text is not italic (see `grok--draft-single.txt`, white `38;2;225;225;225`).

## Do not

- Blind-Enter when the box does not match. That is collie#34.
- Treat a URL as an image chip. URLs are the ghost case.
- Emit a digit because a chip looks numbered. `[Image #1]` is a token, not a permission option.
