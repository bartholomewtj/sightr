// Adapted from T3 Code apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: Sightr's request kinds (permission, trust, menu, password, and whistlr-marked decisions) in
// place of T3's command/file/MCP approvals. The panel replaces the composer box and is the page's
// "you" step (accent fill, border and heading); it carries its own option buttons
// (ComposerPendingApprovalActions). Password and whistlr requests have no buttons: Sightr never types
// a password, and whistlr decisions are answered with `whistlr reply`. A permission request names its
// tool and target (`subject`, read by the bridge from the dialog's own text): the tool is the heading,
// the command or path sits in a capped, scrollable monospace box, and the dialog's question follows.
import { memo, type Ref } from "react";
import { KeyRoundIcon, ShieldIcon, TerminalSquareIcon } from "lucide-react";

import type { RuntimeRequest } from "@shared/v2/contracts";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "@/rightPanelStore";
import { openThreadTerminal } from "@/threadViewStore";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

const KIND_LABEL: Record<RuntimeRequest["kind"], string> = {
  permission: "Permission",
  trust: "Trust this folder?",
  menu: "Choose an option",
  password: "Password prompt",
  question: "Question",
};

/**
 * Opens the thread's Terminal tab (T13): the panel on desktop, a sheet on a phone, or the CLI view for a
 * thread with no transcript. With `prompt` (a
 * password request) it also arms direct typing, and the strip names the prompt being answered.
 */
export function OpenTerminalButton({ threadId, prompt }: { threadId: string; prompt?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        if (prompt !== undefined) useRightPanelStore.getState().requestDirectTyping(threadId, prompt);
        openThreadTerminal(threadId);
      }}
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border-2 border-border bg-card px-3 text-sm font-medium text-foreground hover:border-you pointer-fine:sm:min-h-9"
    >
      <TerminalSquareIcon className="size-4" aria-hidden="true" />
      Open terminal
    </button>
  );
}

interface ComposerPendingApprovalPanelProps {
  request: RuntimeRequest;
  pendingCount: number;
  respondingIndex: number | null;
  verdict: string | null;
  disabled?: boolean;
  firstOptionRef?: Ref<HTMLButtonElement>;
  onRespond: (optionIndex: number) => void;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  request,
  pendingCount,
  respondingIndex,
  verdict,
  disabled = false,
  firstOptionRef,
  onRespond,
}: ComposerPendingApprovalPanelProps) {
  const whistlr = request.via === "whistlr";
  const password = request.kind === "password";
  const subject = request.kind === "permission" ? request.subject : undefined;
  const label = whistlr ? "Decision for the operator" : (subject?.title ?? KIND_LABEL[request.kind]);
  const commandLike = !subject && (request.kind === "permission" || request.kind === "trust");

  return (
    <ComposerBanner.Root variant="you" density="spacious" data-request-kind={request.kind}>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-xs">
          {password ? (
            <KeyRoundIcon className="size-4 text-house-accent" aria-hidden="true" />
          ) : (
            <ShieldIcon className="size-4 text-house-accent" aria-hidden="true" />
          )}
          <h2 className="min-w-0 truncate font-semibold text-house-accent" data-request-title="">
            {label}
          </h2>
          {pendingCount > 1 ? <span className="ml-auto tabular-nums text-muted-foreground">1/{pendingCount}</span> : null}
        </div>
        {subject?.target ? (
          <pre
            className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background/60 px-2.5 py-2 font-[Consolas,ui-monospace,monospace] text-xs text-foreground"
            tabIndex={0}
            aria-label={subject.title === "Run command" ? "Command" : "Target"}
            data-request-target=""
          >
            {subject.target}
          </pre>
        ) : null}
        {subject?.detail ? <p className="text-xs text-muted-foreground">{subject.detail}</p> : null}
        {request.prompt ? (
          <p
            className={cn(
              "max-h-40 overflow-auto text-sm text-foreground",
              commandLike ? "whitespace-pre-wrap font-[Consolas,ui-monospace,monospace] text-xs" : "whitespace-pre-wrap",
            )}
            tabIndex={0}
            aria-label="Prompt"
          >
            {request.prompt}
          </p>
        ) : null}
        {whistlr ? (
          <p className="text-sm text-muted-foreground">Answer with whistlr reply.</p>
        ) : password ? (
          <>
            <p className="text-sm text-muted-foreground">
              This asks for a password. Sightr does not send it. Type it in the Terminal tab.
            </p>
            <div>
              <OpenTerminalButton threadId={request.threadId} prompt={request.prompt.split("\n", 1)[0] ?? ""} />
            </div>
          </>
        ) : request.options.length > 0 ? (
          <ComposerPendingApprovalActions
            options={request.options}
            respondingIndex={respondingIndex}
            disabled={disabled}
            firstOptionRef={firstOptionRef}
            onRespond={onRespond}
          />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">Answer in the Terminal tab.</p>
            <div>
              <OpenTerminalButton threadId={request.threadId} />
            </div>
          </>
        )}
        {verdict ? (
          <p role="status" className="text-xs text-muted-foreground">
            {verdict}
          </p>
        ) : null}
      </div>
    </ComposerBanner.Root>
  );
});
