import { createFileRoute, Outlet } from "@tanstack/react-router";

import { ChatShell } from "@/components/shell/ChatShell";

// The shell layout: home, a thread and the new-thread draft render inside it.
export const Route = createFileRoute("/_chat")({
  component: ChatLayout,
});

function ChatLayout() {
  return (
    <ChatShell>
      <Outlet />
    </ChatShell>
  );
}
