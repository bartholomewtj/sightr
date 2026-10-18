/**
 * Stand-in for T3 Code's `TurnDiffFileChange` (apps/web/src/types.ts @ 3a4d118a518a, MIT), the input
 * of `lib/turnDiffTree.ts`. T3's `types.ts` is the whole web app's model and is not mirrored; the tree
 * reads only these four fields. `additions` and `deletions` are optional: a row with no counts (T24's
 * `countsKnown` false) has none, and its tree node carries `stat: null`.
 */
export interface TurnDiffFileChange {
  readonly path: string;
  readonly kind?: string;
  readonly additions?: number;
  readonly deletions?: number;
}
