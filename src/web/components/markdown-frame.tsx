import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { FrameShell } from "@/components/frame-shell";
import type { Frame } from "@/lib/board";
import { useFile } from "@/lib/room-context";

type MarkdownFrameData = Extract<Frame, { type: "markdown" }>;

/**
 * A markdown file in the host's working dir, read-only (ADR 0002): the host
 * mirrors its content, and changes made on disk — typically by an agent —
 * flow in live.
 */
export function MarkdownFrame({
  frame,
  readOnly,
}: {
  frame: MarkdownFrameData;
  readOnly: boolean;
}) {
  const file = useFile(frame.path);

  return (
    <FrameShell
      frame={frame}
      readOnly={readOnly}
      status={
        <span className="text-muted-foreground truncate font-mono text-[11px]">{frame.path}</span>
      }
    >
      <div data-frame-body="" className="prose-canvas h-full overflow-auto p-4 text-sm select-text">
        {file?.kind === "text" ? (
          <Markdown remarkPlugins={[remarkGfm]}>{file.text}</Markdown>
        ) : (
          <p className="text-muted-foreground text-xs">
            {file?.kind === "denied"
              ? file.reason
              : file?.kind === "missing"
                ? `${frame.path} doesn't exist yet — ask an agent to write it.`
                : "Loading…"}
          </p>
        )}
      </div>
    </FrameShell>
  );
}
