import { createFileRoute, redirect } from "@tanstack/react-router";

/** v1's `/space/:id` (an old bookmark): spaces are projects in the thread list now (T15). */
export const Route = createFileRoute("/space/$spaceId")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
