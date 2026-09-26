import { Code, Eye, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CodeView } from "@/components/code-view";
import { FileTree } from "@/components/file-tree";
import { FrameShell } from "@/components/frame-shell";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { addFrame, updateFrame, type FileView, type Frame } from "@/lib/board";
import { useFile, useRoom } from "@/lib/room-context";
import type { FileContent } from "../../shared/protocol";

type FileFrameData = Extract<Frame, { type: "file" }>;

const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * A file of the host's working dir, read-only (ADR 0002). Which file and how
 * it is shown (markdown: rendered or source) are shared; the tree panel is
 * each viewer's own. Changes on disk — typically an agent's — flow in live.
 */
export function FileFrame({ frame, readOnly }: { frame: FileFrameData; readOnly: boolean }) {
  const room = useRoom();
  const file = useFile(frame.path);
  const markdown = isMarkdown(frame.path);
  const view: FileView = frame.view ?? (markdown ? "preview" : "source");
  // `view` guests don't get the tree (ADR 0002).
  const canBrowse = !readOnly;
  const [treeOpen, setTreeOpen] = useState(canBrowse && !frame.path);
  const tree = useRef<PanelImperativeHandle>(null);

  const toggleTree = () => {
    if (tree.current?.isCollapsed()) tree.current.expand();
    else tree.current?.collapse();
  };

  // Stable, so the tree does not re-render with every frame change.
  const latest = useRef(frame);
  useEffect(() => {
    latest.current = frame;
  });
  const open = useCallback(
    (path: string, newFrame: boolean) => {
      const { id, x, y, w, h } = latest.current;
      if (newFrame)
        addFrame(room.doc, { type: "file", path, title: basename(path), x: x + w + 32, y, w, h });
      else updateFrame(room.doc, id, { path, title: basename(path), view: null });
    },
    [room.doc],
  );

  const body = (
    <FileBody path={frame.path} file={file} view={view} empty={canBrowse ? "tree" : "none"} />
  );

  return (
    <FrameShell
      frame={frame}
      readOnly={readOnly}
      status={
        <span
          className="text-muted-foreground max-w-[45%] truncate font-mono text-[11px]"
          title={frame.path}
        >
          {frame.path}
        </span>
      }
      actions={
        <>
          {markdown && (
            <Button
              size="icon-sm"
              variant="ghost"
              className="size-6"
              title={view === "preview" ? "Show source" : "Show preview"}
              disabled={readOnly}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() =>
                updateFrame(room.doc, frame.id, {
                  view: view === "preview" ? "source" : "preview",
                })
              }
            >
              {view === "preview" ? <Code /> : <Eye />}
            </Button>
          )}
          {canBrowse && (
            <Button
              size="icon-sm"
              variant="ghost"
              className="size-6"
              title={treeOpen ? "Hide files" : "Show files"}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={toggleTree}
            >
              {treeOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
          )}
        </>
      }
    >
      {canBrowse ? (
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel
            panelRef={tree}
            collapsible
            collapsedSize={0}
            minSize="18"
            maxSize="60"
            defaultSize={treeOpen ? "32" : "0"}
            onResize={() => setTreeOpen(!tree.current?.isCollapsed())}
            className="bg-muted/30"
          >
            {/* Collapsed panels keep their content laid out; don't let it leak. */}
            {treeOpen && <FileTree path={frame.path} onOpen={open} />}
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel minSize="30">{body}</ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        body
      )}
    </FrameShell>
  );
}

function FileBody({
  path,
  file,
  view,
  empty,
}: {
  path: string;
  file: FileContent | undefined;
  view: FileView;
  empty: "tree" | "none";
}) {
  if (!path)
    return (
      <Notice>{empty === "tree" ? "Pick a file from the tree." : "No file picked yet."}</Notice>
    );
  if (!file) return <Notice>Loading {path}…</Notice>;
  switch (file.kind) {
    case "missing":
      return <Notice>{path} doesn't exist yet — it shows up here once an agent writes it.</Notice>;
    case "denied":
      return <Notice>{file.reason}</Notice>;
    case "binary":
      return <Notice>Binary file ({formatSize(file.size)}) — not shown.</Notice>;
    case "too-large":
      return <Notice>Too large to show ({formatSize(file.size)}).</Notice>;
    case "text":
      return view === "preview" ? (
        <div
          data-frame-body=""
          className="prose-canvas h-full overflow-auto p-4 text-sm select-text"
        >
          <Markdown remarkPlugins={[remarkGfm]}>{file.text}</Markdown>
        </div>
      ) : (
        <div data-frame-body="" className="h-full select-text">
          <CodeView path={path} text={file.text} wrap={isMarkdown(path)} />
        </div>
      );
  }
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground p-4 text-xs">{children}</p>;
}

function formatSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KiB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
