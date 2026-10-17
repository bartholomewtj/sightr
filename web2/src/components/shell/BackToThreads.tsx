// The header back button of every full-screen phone view (thread, new thread, settings, archived).
// A plain link to "/" would push a second home entry, so the system back gesture then returned to the
// screen just left; when the list is the entry behind this one, this goes back to it instead. A deep
// link (a push notification opening a thread) has nothing behind it, so it replaces with the list.
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { useEffect, type MouseEvent } from "react";

import { Button } from "~/components/ui/button";

export interface NavTrail {
  /** The index of the history entry the last push left, or null before the first navigation. */
  index: number | null;
  /** The entry directly behind the current one is the thread list. */
  fromList: boolean;
}

/** The trail after a navigation that moved from history index `from` to `to` (a pure step, for tests). */
export function nextNavTrail(trail: NavTrail, step: { from: number | undefined; to: number | undefined; fromIsList: boolean }): NavTrail {
  const { from, to, fromIsList } = step;
  if (from === undefined || to === undefined) return { index: to ?? null, fromList: false };
  if (to > from) return { index: to, fromList: fromIsList }; // a push
  if (to < from) return { index: to, fromList: false }; // back: what is behind us now is unknown
  return { index: to, fromList: trail.fromList }; // a replace keeps the entry behind it
}

let trail: NavTrail = { index: null, fromList: false };

/** Test helper. */
export function __resetNavTrail(next: NavTrail = { index: null, fromList: false }): void {
  trail = next;
}

/** Records, app-wide, whether the entry behind the current one is the thread list. Mount once. */
export function useNavTrail(): void {
  const router = useRouter();
  useEffect(() => {
    const base = router.basepath.replace(/\/+$/, "");
    const isList = (path: string) => path === "/" || path === "" || path === base || path === `${base}/`;
    return router.subscribe("onResolved", ({ fromLocation, toLocation }) => {
      trail = nextNavTrail(trail, {
        from: fromLocation?.state?.__TSR_index,
        to: toLocation.state?.__TSR_index,
        fromIsList: fromLocation !== undefined && isList(fromLocation.pathname),
      });
    });
  }, [router]);
}

export function BackToThreads({ label = "Back to threads" }: { label?: string }) {
  const router = useRouter();
  const onClick = (e: MouseEvent<HTMLElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (trail.fromList && router.history.canGoBack()) router.history.back();
    else void router.navigate({ to: "/", replace: true });
  };
  return (
    <Button size="icon-sm" variant="ghost" aria-label={label} className="-ml-1" render={<Link to="/" onClick={onClick} />}>
      <ChevronLeft className="size-5" />
    </Button>
  );
}
