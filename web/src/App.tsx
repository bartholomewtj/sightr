import { RouterProvider } from "react-router";

import { router } from "./router";
import { BusyBar } from "@/components/busy-bar";
import { useLockGate } from "@/hooks/use-lock-gate";
import { LockPrompt } from "@/components/lock-prompt";

// App renders the reconnect lock gate, the global busy indicator, and the route tree.
export function App() {
  const { gate, onUnlocked } = useLockGate();
  if (gate.status === "loading") return null;
  if (gate.status === "locked") return <LockPrompt onUnlocked={onUnlocked} />;
  return (
    <>
      <BusyBar />
      <RouterProvider router={router} />
    </>
  );
}
