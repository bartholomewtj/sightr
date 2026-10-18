// Sightr code (T25). Counts React commits and component renders through the DevTools global hook, the way
// the T23 compiler spike counted "commits / component renders". Import this module before `react-dom`
// loads (the hook is read once, at `inject`). Works in a production build, which has no Profiler.
export type CommitStats = { commits: number; renders: number };

const stats: CommitStats = { commits: 0, renders: 0 };
const PERFORMED_WORK = 1;
const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]); // function, class, forwardRef, memo, simple memo

type Fiber = { tag: number; flags: number; child: Fiber | null; sibling: Fiber | null };

function rendered(root: Fiber | null): number {
  let n = 0;
  const stack: Fiber[] = root ? [root] : [];
  while (stack.length) {
    const f = stack.pop() as Fiber;
    if (COMPONENT_TAGS.has(f.tag) && (f.flags & PERFORMED_WORK) !== 0) n++;
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  return n;
}

export function installCommitHook(): void {
  const g = globalThis as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: Record<string, unknown> };
  if (g.__REACT_DEVTOOLS_GLOBAL_HOOK__?.sightrSpike) return;
  let next = 0;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    sightrSpike: true,
    supportsFiber: true,
    renderers: new Map(),
    inject() { return ++next; },
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      stats.commits++;
      stats.renders += rendered(root.current);
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  };
}

export function resetCommitStats(): void {
  stats.commits = 0;
  stats.renders = 0;
}
export function readCommitStats(): CommitStats {
  return { ...stats };
}

installCommitHook();
