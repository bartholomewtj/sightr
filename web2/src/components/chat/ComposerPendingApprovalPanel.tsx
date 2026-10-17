// Adapted from T3 Code apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx @ e3b35d1b (MIT, see THIRD_PARTY.md).
// Changes: Sightr's request kinds (permission, trust, menu, password, and whistlr-marked decisions) in
// place of T3's command/file/MCP approvals. The panel replaces the composer box and is the page's
// "you" step (accent fill, border and heading); it carries its own option buttons
// (ComposerPendingApprovalActions). Password and whistlr requests have no buttons: Sightr never types
// a password, and whistlr decisions are answered with `whistlr reply`.
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
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border-2 border-border bg-card px-3 text-sm font-medium text-foreground hover:border-you sm:min-h-9"
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
  const label = whistlr ? "Decision for the operator" : KIND_LABEL[request.kind];
  const commandLike = request.kind === "permission" || request.kind === "trust";

  return (
    <ComposerBanner.Root variant="you" density="spacious" data-request-kind={request.kind}>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-xs">
          {password ? (
            <KeyRoundIcon className="size-4 text-house-accent" aria-hidden="true" />
          ) : (
            <ShieldIcon className="size-4 text-house-accent" aria-hidden="true" />
          )}
          <h2 className="font-semibold text-house-accent">{label}</h2>
          {pendingCount > 1 ? <span className="ml-auto tabular-nums text-muted-foreground">1/{pendingCount}</span> : null}
        </div>
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
