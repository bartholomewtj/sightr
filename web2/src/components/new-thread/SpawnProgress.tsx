// The start in progress (T14), bound to the `thread.create` command and then to its thread: Creating
// pane → Starting {harness} → Ready (opens the thread) or Failed (the bridge's reason, the command that
// was tried, "Edit and try again"). It is rebuilt from the thread's status after a reload. Leaving the
// screen does not cancel anything: the thread is in the sidebar with its status.
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CircleAlertIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "@/lib/utils";
import { openThreadTerminal } from "@/threadViewStore";
import { editAndRetry, finishStart, readyToOpen, retryFirstMessage, type DraftStart } from "@/state/draft-thread";
import { useShell } from "@/stream/stores";

import { READY_NAV_MS, STILL_STARTING_MS } from "./NewThread.logic";

type StepState = "done" | "active" | "todo" | "failed";

export function SpawnProgress({ start, now: clock = () => Date.now() }: { start: DraftStart; now?: () => number }) {
  const navigate = useNavigate();
  const thread = useShell((s) => (start.threadId ? (s.threads[start.threadId] ?? null) : null));
  const [now, setNow] = useState(clock);
  const running = start.phase === "creating" || start.phase === "starting";

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(clock()), 1_000);
    return () => clearInterval(id);
  }, [running, clock]);

  const open = readyToOpen(start);
  const threadId = start.threadId;
  useEffect(() => {
    if (!open || !threadId) return;
    const id = setTimeout(() => {
      void navigate({ to: "/thread/$threadId", params: { threadId } });
      finishStart();
    }, READY_NAV_MS);
    return () => clearTimeout(id);
  }, [open, threadId, navigate]);

  const openTerminal = () => {
    if (!threadId) return;
    void navigate({ to: "/thread/$threadId", params: { threadId } });
    openThreadTerminal(threadId);
  };

  const slow = running && now - start.startedAt >= STILL_STARTING_MS;
  const paneExists = thread !== null && thread.shelf !== "archived";
  const steps: { label: string; state: StepState }[] = [
    { label: "Creating pane", state: start.phase === "creating" ? "active" : start.threadId ? "done" : "failed" },
    {
      label: `Starting ${start.harnessLabel}`,
      state: start.phase === "starting" ? "active" : start.phase === "ready" ? "done" : start.phase === "failed" && start.threadId ? "failed" : "todo",
    },
    { label: "Ready", state: start.phase === "ready" ? (open ? "done" : "active") : "todo" },
  ];

  return (
    <section aria-label="Starting the thread" className="mx-auto flex w-full max-w-md flex-col gap-4">
      <ol aria-live="polite" className="flex flex-col gap-2">
        {steps.map((step) => (
          <li key={step.label} className={cn("flex items-center gap-2 text-sm", step.state === "todo" && "text-muted-foreground")}>
            <StepIcon state={step.state} />
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
      <div aria-live="polite" className="flex flex-col gap-2">
        {start.firstMessage && start.phase !== "failed" ? (
          <p className="text-xs text-muted-foreground">
            {start.messageState === "sent"
              ? "First message queued; it is sent when the agent is ready."
              : start.messageState === "failed"
                ? null
                : "Queuing the first message…"}
          </p>
        ) : null}
        {start.messageState === "failed" ? (
          <div role="alert" className="flex flex-col gap-2 text-sm text-warn">
            <p>The first message was not queued: {start.messageError}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={retryFirstMessage}>
                Try again
              </Button>
              {threadId ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void navigate({ to: "/thread/$threadId", params: { threadId } })}
                >
                  Open the thread
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {slow ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>Still starting…</p>
            {threadId ? (
              <Button size="sm" variant="outline" className="self-start" onClick={openTerminal}>
                Open terminal
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="self-start" onClick={editAndRetry}>
                Back to the draft
              </Button>
            )}
          </div>
        ) : null}
        {start.phase === "failed" ? (
          <div role="alert" className="flex flex-col gap-2 text-sm">
            <p className="text-warn">{start.failure?.message ?? "The start failed. The thread's timeline says why."}</p>
            {start.commandLine ? (
              <p className="text-xs text-muted-foreground">
                Tried: <code className="font-mono">{start.commandLine}</code>
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={editAndRetry}>
                Edit and try again
              </Button>
              {paneExists ? (
                <Button size="sm" variant="outline" onClick={openTerminal}>
                  Open as terminal
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <CheckIcon className="size-4 text-ok" aria-label="Done" />;
  if (state === "active") return <Loader2Icon className="size-4 animate-spin" aria-label="In progress" />;
  if (state === "failed") return <CircleAlertIcon className="size-4 text-warn" aria-label="Failed" />;
  return <span className="inline-block size-4 rounded-full border" aria-hidden />;
}
