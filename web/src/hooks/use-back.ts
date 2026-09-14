// Header "‹" = the phone's back gesture: pop ONE history entry. The two used to disagree — the
// header jumped to a computed "parent" screen (home, the pane, the folder above) while the gesture
// went one step — so going pane → pane → "‹" skipped the pane you'd just left. Now they match.
//
// `fallback` covers a cold entry with nothing behind it (deep link, notification tap, relaunch on the boot entry): history.back() there would leave the app or do nothing, so we go
// to the screen the old header went to instead. replace, not push: a push on a boot entry (idx 0)
// leaves the child behind, so the next press pops back to it and the header ping-pongs. #154.
import { useNavigate } from "react-router";

/** True when there is an in-app history entry behind this one. React Router stamps its own index
 *  (`idx`) into history.state on every entry it creates, starting at 0 on the entry it booted on.
 *  A relaunch restores the last path as that boot entry (idx 0), so ‹ there goes to the route's
 *  `fallback`. */
export function canGoBack(): boolean {
  const state = window.history.state as { idx?: number } | null;
  return typeof state?.idx === "number" && state.idx > 0;
}

export function useBack(fallback: string): () => void {
  const navigate = useNavigate();
  return () => {
    if (canGoBack()) navigate(-1);
    else navigate(fallback, { replace: true });
  };
}
