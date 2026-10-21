// Adapted from T3 Code apps/web/src/components/chat/MarkdownMermaidCodeBlock.tsx @ 688ee52f0e8f
// (MIT, see THIRD_PARTY.md). Sightr's own body: the diagram is drawn unless the reader asked for the
// code, and the highlighted code block (this component's `children`) is the fallback in every state
// where the diagram cannot stand in for it — while pele's chunk loads, and after any failure. The
// error boundary is local instead of T3's RenderErrorBoundary, and there is no find-in-thread reveal.
import { CodeIcon, WorkflowIcon } from "lucide-react";
import { Component, Suspense, useState, type ReactNode } from "react";

import { MermaidDiagram } from "./MermaidDiagram";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface DiagramBoundaryState {
  failed: boolean;
}

/** Shows `fallback` (the code block) once the diagram has thrown; a new source tries again. */
class DiagramBoundary extends Component<
  { fallback: ReactNode; resetKey: string; children?: ReactNode },
  DiagramBoundaryState
> {
  state: DiagramBoundaryState = { failed: false };

  static getDerivedStateFromError(): DiagramBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previous: { resetKey: string }) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * A `mermaid` fence: the rendered diagram, with a "Show code" toggle (the fence title when the author
 * gave one). An empty fence has nothing to draw, so the code block shows instead.
 */
export function MarkdownMermaidCodeBlock({
  code,
  fenceTitle = null,
  children,
}: {
  code: string;
  fenceTitle?: string | null;
  children: ReactNode;
}) {
  const [showCode, setShowCode] = useState(false);
  const hasSource = code.trim().length > 0;
  const showDiagram = hasSource && !showCode;
  const toggleLabel = showCode ? "Show diagram" : "Show code";

  return (
    <div className="chat-markdown-mermaid-block my-[0.65rem] min-w-0" data-language="mermaid">
      <div
        className="flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none pointer-coarse:min-h-11"
        data-thread-find-ignore=""
      >
        {showDiagram ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-2xs">
            <span className="truncate">{fenceTitle ?? "mermaid"}</span>
          </span>
        ) : (
          <span />
        )}
        {hasSource ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-xs"
                  onClick={() => setShowCode((value) => !value)}
                  aria-label={toggleLabel}
                />
              }
            >
              {showCode ? <WorkflowIcon className="size-3" /> : <CodeIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{toggleLabel}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {showDiagram ? (
        <DiagramBoundary resetKey={code} fallback={children}>
          <Suspense fallback={children}>
            <MermaidDiagram source={code} />
          </Suspense>
        </DiagramBoundary>
      ) : (
        children
      )}
    </div>
  );
}
