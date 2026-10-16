// The first message (T14): optional, a plain text box and attachments as in T12's composer (no slash
// menu here). It is not typed by the browser and not part of `thread.create`: once the thread exists,
// the files upload to its pane and one `message.dispatch {mode: "queue"}` goes to the bridge (T06).
// Enter follows T12's per-device setting.
import { PaperclipIcon, XIcon } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";

import { Button } from "~/components/ui/button";
import { resolveEnterAction } from "@/components/chat/ChatComposer.logic";
import { useLayout } from "@/hooks/useLayout";
import { resolveEnterMode, useComposerSettings } from "@/state/composer";
import { addDraftAttachments, removeDraftAttachment, setDraftText, useDraftThread } from "@/state/draft-thread";

export function DraftFirstMessage({ onSubmit }: { onSubmit(): void }) {
  const text = useDraftThread((s) => s.draft.text);
  const files = useDraftThread((s) => s.attachments);
  const layout = useLayout();
  const enterMode = resolveEnterMode(useComposerSettings((s) => s.enterMode), layout);
  const fileInput = useRef<HTMLInputElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = resolveEnterAction(e.nativeEvent, enterMode);
    if (action === "submit" || action === "submit-alternate") {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <section className="flex w-full flex-col gap-1.5" aria-label="First message">
      <div className="rounded-lg border bg-background focus-within:ring-2 focus-within:ring-ring">
        <textarea
          aria-label="First message (optional)"
          placeholder="First message (optional)"
          value={text}
          rows={3}
          onChange={(e) => setDraftText(e.target.value)}
          onKeyDown={onKeyDown}
          className="block max-h-60 min-h-20 w-full resize-y bg-transparent px-3 py-2 text-base outline-none sm:text-sm"
        />
        <div className="flex flex-wrap items-center gap-1.5 border-t px-2 py-1.5">
          <Button size="icon-sm" variant="ghost-muted" aria-label="Attach files" onClick={() => fileInput.current?.click()}>
            <PaperclipIcon />
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="draft-attach-input"
            onChange={(e) => {
              addDraftAttachments([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          {files.map((file, i) => (
            <span key={`${file.name}:${i}`} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs">
              {file.name || "attachment"}
              <button type="button" aria-label={`Remove ${file.name || "attachment"}`} onClick={() => removeDraftAttachment(i)}>
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
          {files.length > 0 ? <span className="text-xs text-muted-foreground">Uploaded to the new pane when it exists.</span> : null}
        </div>
      </div>
    </section>
  );
}
