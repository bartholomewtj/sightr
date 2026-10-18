// Pattern from T3 Code apps/web/src/components/diffs/AnnotatableCodeView.tsx @ 3a4d118a518a (MIT, see THIRD_PARTY.md).
// T3 wraps its Pierre `CodeView`: a gutter "+" starts a draft annotation on a selected range, Save puts the comment in
// the Tiptap composer's draft. This wraps the `DiffCodeView` seam instead (T29), so it imports no `@pierre/*`: the
// seam gives it a per-row gutter action, a `selection` and annotation rows; this file owns what a tap means (start a
// range, extend it, open the editor under its last line), saves to the pending list (state/lineComments.ts) and
// draws the saved notes. Outside the Diff panel (no `DiffCommentsContext`) it is a plain `DiffCodeView`.
import { createContext, useCallback, useContext, useEffect, useMemo } from "react";

import { commentPathProblem, COMMENT_PATH_REASON } from "@/lib/refusedPaths";
import { addLineComment, ADD_REFUSAL, editLineComment, reanchorFile, useLineComments, type LineComment } from "@/state/lineComments";
import { deleteWithUndo } from "@/state/commentActions";
import { clearLineReveal, currentNote, getOpenEditor, patchOpenEditor, setLiveNote, setOpenEditor, useLineReveal, useOpenEditor } from "@/state/commentsUi";

import { DiffCodeView, type DiffAnnotation, type DiffLineRef, type DiffSelection } from "./DiffCodeView";
import { DiffCommentAnnotation, rangeLabelOf } from "./DiffCommentAnnotation";
import { DiffCommentEditor } from "./DiffCommentEditor";
import { clearRange, extendGesture, quoteFor, rangeOf, startGesture } from "./lineSelection";
import { useParsedFile } from "./parsedFile";

/** What the Diff panel tells its file bodies: which thread's comments, and a reason comments are off for the whole panel (a read-only device). */
export interface DiffCommentsContextValue {
  threadId: string;
  off: string | null;
}
export const DiffCommentsContext = createContext<DiffCommentsContextValue | null>(null);

const EDITOR_KEY = "editor";
const LIMIT_NOTICE = "12 lines is the limit.";

const isCoarse = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

type BodyProps = { patch: string; path: string; wrap: boolean; eager: boolean };

export function AnnotatableCodeView(props: BodyProps) {
  const ctx = useContext(DiffCommentsContext);
  if (!ctx) return <DiffCodeView patch={props.patch} filePath={props.path} wrap={props.wrap} eager={props.eager} header={false} />;
  return <Commentable {...props} ctx={ctx} />;
}

function Commentable({ patch, path, wrap, eager, ctx }: BodyProps & { ctx: DiffCommentsContextValue }) {
  const { threadId } = ctx;
  const file = useParsedFile(patch);
  const problem = commentPathProblem(path);
  const off = ctx.off ?? (problem ? COMMENT_PATH_REASON[problem] : null);
  const all = useLineComments(threadId);
  const editor = useOpenEditor(threadId);
  const reveal = useLineReveal(threadId);
  const here = editor?.path === path ? editor : null;

  // The file's diff loaded or refreshed: find each comment's lines again (same place, moved, or outdated).
  useEffect(() => {
    if (!problem) reanchorFile(threadId, path, file);
  }, [threadId, path, file, problem]);

  // An editor opened from the list names its range before the file's patch was at hand; place it in a hunk now.
  const unplaced = here !== null && here.gesture.hunk < 0;
  useEffect(() => {
    const cur = getOpenEditor(threadId);
    if (!unplaced || !cur || cur.path !== path) return;
    const g = startGesture(file, { side: cur.gesture.side, line: cur.gesture.anchor });
    if (g) patchOpenEditor(threadId, { gesture: { ...cur.gesture, hunk: g.hunk } });
  }, [unplaced, threadId, path, file]);

  const saved = useMemo(() => all.filter((c) => c.path === path && c.state !== "outdated" && c.id !== here?.editingId), [all, path, here?.editingId]);
  const range = here ? rangeOf(here.gesture) : null;

  const annotations = useMemo<DiffAnnotation[]>(() => {
    const list: DiffAnnotation[] = saved.map((c) => ({ at: { filePath: path, side: c.side, line: c.end }, key: `c:${c.id}` }));
    if (range) list.push({ at: { filePath: path, side: range.side, line: range.end }, key: EDITOR_KEY });
    return list;
  }, [saved, path, range?.side, range?.end]);
  const selection = useMemo<DiffSelection | undefined>(() => (range ? { side: range.side, start: range.start, end: range.end } : undefined), [range?.side, range?.start, range?.end]);

  const save = useCallback(
    (note: string) => {
      const cur = getOpenEditor(threadId);
      if (!cur || cur.path !== path) return;
      const r = rangeOf(cur.gesture);
      const quote = quoteFor(file, r);
      if (!quote) return patchOpenEditor(threadId, { notice: "Those lines are not in this diff any more." });
      const result = cur.editingId ? editLineComment(threadId, cur.editingId, { note, range: { start: r.start, end: r.end, quote } }) : addLineComment(threadId, { path, side: r.side, start: r.start, end: r.end, quote, note });
      if (!result.ok) return patchOpenEditor(threadId, { notice: ADD_REFUSAL[result.reason] });
      setOpenEditor(threadId, null);
    },
    [threadId, path, file],
  );

  const onEdit = useCallback(
    (c: LineComment) => {
      const g = startGesture(file, { side: c.side, line: c.start });
      if (!g) return;
      setOpenEditor(threadId, { path, gesture: { ...g, head: c.end }, note: c.note, editingId: c.id, notice: null });
    },
    [threadId, path, file],
  );

  const renderAnnotation = useCallback(
    (a: DiffAnnotation) => {
      if (a.key === EDITOR_KEY) {
        const cur = getOpenEditor(threadId);
        if (!cur || cur.path !== path) return null;
        const r = rangeOf(cur.gesture);
        return (
          <DiffCommentEditor
            // A different comment or file is a fresh editor; a bigger range is the same one.
            key={cur.editingId ?? "new"}
            rangeLabel={rangeLabelOf(r)}
            side={r.side}
            initialNote={currentNote(threadId)}
            canClear={r.end > r.start}
            notice={cur.notice}
            editing={cur.editingId !== null}
            onSave={save}
            onCancel={() => setOpenEditor(threadId, null)}
            onClear={() => patchOpenEditor(threadId, { gesture: clearRange(cur.gesture), notice: null })}
            onNote={(note) => setLiveNote(threadId, note)}
          />
        );
      }
      const c = saved.find((x) => `c:${x.id}` === a.key);
      return c ? <DiffCommentAnnotation comment={c} onEdit={onEdit} onDelete={(x) => deleteWithUndo(threadId, x.id)} /> : null;
    },
    [saved, threadId, path, save, onEdit],
  );

  const onLineAction = useCallback(
    (at: DiffLineRef, { shiftKey }: { shiftKey: boolean }) => {
      const cur = getOpenEditor(threadId);
      if (cur && cur.path === path && (shiftKey || isCoarse())) {
        // The shift-click rule; on a phone, which has no shift key, any tap while the editor is open.
        const next = extendGesture(file, cur.gesture, at);
        const notice = next.skipped ? "That row has no line number on this side." : next.limited ? LIMIT_NOTICE : null;
        patchOpenEditor(threadId, { gesture: next.gesture, notice });
        return;
      }
      const g = startGesture(file, at);
      if (!g) return;
      const sameFile = cur?.path === path;
      setOpenEditor(threadId, { path, gesture: g, note: sameFile ? currentNote(threadId) : "", editingId: sameFile ? cur.editingId : null, notice: null });
    },
    [threadId, path, file],
  );

  const revealLine = reveal && reveal.path === path ? { side: reveal.side, line: reveal.line, key: reveal.key } : undefined;
  const revealKey = revealLine?.key;
  // The adapter scrolls in the commit that first shows this reveal; after that it is spent.
  useEffect(() => {
    if (revealKey === undefined) return;
    const t = setTimeout(() => clearLineReveal(threadId, revealKey), 800);
    return () => clearTimeout(t);
  }, [threadId, revealKey]);

  return (
    <div data-diff-commentable="" data-diff-comments={off ? "off" : "on"}>
      {problem ? (
        <p className="px-2 py-1 text-xs text-muted-foreground" data-diff-comments-off="">
          {off}
        </p>
      ) : null}
      <DiffCodeView
        patch={patch}
        parsed={file}
        filePath={path}
        wrap={wrap}
        eager={eager}
        header={false}
        annotations={annotations}
        renderAnnotation={renderAnnotation}
        {...(off ? {} : { onLineAction })}
        {...(selection ? { selection } : {})}
        {...(revealLine ? { revealLine } : {})}
      />
    </div>
  );
}
