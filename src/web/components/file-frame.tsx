import { Code, Eye, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { Root } from "hast";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { CodeView } from "@/components/code-view";
import { FileTree } from "@/components/file-tree";
import { FrameShell } from "@/components/frame-shell";
import { RemoteSelections } from "@/components/remote-selections";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  addFrame,
  allFrames,
  updateFrame,
  type FileView,
  type Frame,
  type LineRange,
} from "@/lib/board";
import { placeNew } from "../../shared/layout";
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
  // Lines only show in the source; a range asked for means the source.
  const view: FileView = frame.view ?? (markdown && !frame.lines ? "preview" : "source");
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
      const { id, w, h } = latest.current;
      if (newFrame) {
        const { rect, patches } = placeNew(
          allFrames(room.doc),
          { anchor: id, side: "right" },
          {
            w,
            h,
          },
        );
        addFrame(room.doc, { type: "file", path, title: basename(path), ...rect }, patches);
      } else updateFrame(room.doc, id, { path, title: basename(path), view: null, lines: null });
    },
    [room.doc],
  );

  const body = (
    <FileBody
      frameId={frame.id}
      path={frame.path}
      lines={frame.lines}
      file={file}
      view={view}
      empty={canBrowse ? "tree" : "none"}
    />
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
  frameId,
  path,
  lines,
  file,
  view,
  empty,
}: {
  frameId: string;
  path: string;
  lines: LineRange | null | undefined;
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
        <MarkdownPreview frameId={frameId} path={path} text={file.text} />
      ) : (
        <div data-frame-body="" className="h-full select-text">
          <CodeView
            frameId={frameId}
            path={path}
            text={file.text}
            wrap={isMarkdown(path)}
            lines={lines}
          />
        </div>
      );
  }
}

/**
 * Keys each top-level block by its source line, so a selection resolves to
 * the same text on every peer. An edit above it changes the key: the remote
 * selection disappears rather than point at the wrong block.
 */
function keyBlocks() {
  return (tree: Root) => {
    for (const node of tree.children)
      if (node.type === "element")
        node.properties = { ...node.properties, dataSelKey: `L${node.position?.start.line ?? 0}` };
  };
}
const REHYPE = [keyBlocks];
const REMARK = [remarkGfm];

function MarkdownPreview({ frameId, path, text }: { frameId: string; path: string; text: string }) {
  return (
    <div data-frame-body="" className="h-full overflow-auto">
      <div data-sel-root={frameId} data-sel-path={path} className="relative p-4">
        <div className="prose-canvas text-sm select-text">
          <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE}>
            {text}
          </Markdown>
        </div>
        <RemoteSelections frameId={frameId} path={path} version={text} />
      </div>
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground p-4 text-xs">{children}</p>;
}

function formatSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KiB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
