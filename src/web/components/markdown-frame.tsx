import { Eye, Pencil } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CollabEditor } from "@/components/collab-editor";
import { FrameShell } from "@/components/frame-shell";
import { Button } from "@/components/ui/button";
import { markdownText, type Frame } from "@/lib/board";
import { useRoom } from "@/lib/room-context";

type MarkdownFrameData = Extract<Frame, { type: "markdown" }>;

/**
 * A markdown artifact: a file in the host's working dir. Edits are
 * collaborative (a shared Y.Text the host writes back to the file) and
 * changes made on disk — typically by an agent — flow back in live.
 */
export function MarkdownFrame({
  frame,
  readOnly,
}: {
  frame: MarkdownFrameData;
  readOnly: boolean;
}) {
  const room = useRoom();
  const [editing, setEditing] = useState(false);
  const text = useMemo(() => markdownText(room.doc, frame.id), [room.doc, frame.id]);
  const content = useSyncExternalStore(
    (onChange) => {
      text.observe(onChange);
      return () => text.unobserve(onChange);
    },
    () => text.toString(),
  );

  return (
    <FrameShell
      frame={frame}
      readOnly={readOnly}
      status={
        <span className="text-muted-foreground truncate font-mono text-[11px]">{frame.path}</span>
      }
      actions={
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-6"
          title={editing ? "Preview" : "Edit"}
          disabled={readOnly}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setEditing(!editing)}
        >
          {editing ? <Eye /> : <Pencil />}
        </Button>
      }
    >
      {editing ? (
        <div data-frame-body="" className="h-full overflow-auto">
          <CollabEditor
            text={text}
            readOnly={readOnly}
            className="h-full [&_.cm-scroller]:font-mono!"
          />
        </div>
      ) : (
        <div
          data-frame-body=""
          className="prose-canvas h-full overflow-auto p-4 text-sm select-text"
        >
          {content ? (
            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
          ) : (
            <p className="text-muted-foreground text-xs">
              Empty — edit it here, or ask an agent to write {frame.path}.
            </p>
          )}
        </div>
      )}
    </FrameShell>
  );
}
