import { createFileRoute, redirect } from "@tanstack/react-router";

/** v1's `/spaces` (an old bookmark): v2 has no such screen, so it lands on the thread list (T15). */
export const Route = createFileRoute("/spaces")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
