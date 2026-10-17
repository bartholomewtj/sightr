// Same job and name as T3 Code apps/web/src/components/DiffFilePathCopyButton.tsx @ db5919d87 (pattern;
// MIT, see THIRD_PARTY.md): a small button on a diff file row that copies its path. Sightr's own body:
// no hover tooltip (a phone has no hover), the house toast says it worked, and the copy falls back to
// execCommand where the Clipboard API is missing (MessageCopyButton's `copyText`). A thumb-sized target
// on a touch screen comes from the Button's coarse-pointer hit area.
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { copyText } from "./chat/MessageCopyButton";
import { showToast } from "./toast";
import { Button } from "./ui/button";

const COPIED_MS = 1500;

export function DiffFilePathCopyButton({ filePath }: { filePath: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      aria-label={`Copy path ${filePath}`}
      title="Copy path"
      onClick={(event) => {
        event.stopPropagation();
        void copyText(filePath).then((ok) => {
          if (ok) setCopied(true);
          showToast(ok ? "Path copied" : "Couldn't copy the path", ok ? undefined : "error");
        });
      }}
    >
      {copied ? <CheckIcon className="text-ok" /> : <CopyIcon />}
    </Button>
  );
}
