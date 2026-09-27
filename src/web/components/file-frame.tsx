import {
  Code,
  Eye,
  FolderTree,
  ListTree,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import type { ElementContent, Root } from "hast";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  LinkScope,
  MARKDOWN_LINKS,
  urlTransform,
  useGo,
  useLinkBase,
} from "@/components/board-link";
import { CodeView } from "@/components/code-view";
import { CommentCard, CommentComposer, CommentsButton } from "@/components/comments";
import { FileTree } from "@/components/file-tree";
import { FrameShell } from "@/components/frame-shell";
import { RemoteSelections } from "@/components/remote-selections";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { domSurface, useFollowScroll } from "@/hooks/use-follow-scroll";
import {
  addFrame,
  allFrames,
  fileView,
  hasPreview,
  isHtml,
  isMarkdown,
  updateFrame,
  type FileEntry,
  type FileView,
  type Frame,
  type LineRange,
} from "@/lib/board";
import {
  addComment,
  editComment,
  mayChange,
  rangeOf,
  removeComment,
  settle,
  useComments,
  type Comment,
  type Editor,
} from "@/lib/comments";
import { SCRATCH_PREFIX } from "../../shared/board-tools";
import { quoteOf, relocate } from "../../shared/comments";
import { placeNew } from "../../shared/layout";
import { parseLink, Slugger } from "@/lib/board-link";
import { bridgedLink, withLinkBridge } from "@/lib/link-bridge";
import { entryFor } from "@/lib/file-list";
import { revealed, useReveal } from "@/lib/reveal";
import { useFile, useRoom, useTree } from "@/lib/room-context";
import { cn } from "@/lib/utils";
import type { FileContent } from "../../shared/protocol";

type FileFrameData = Extract<Frame, { type: "file" }>;

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * A file of the host's working dir, read-only (ADR 0002). Which file and how
 * it is shown (markdown and HTML: rendered or source) are shared; the tree panel is
 * each viewer's own. Changes on disk — typically an agent's — flow in live.
 *
 * An agent may give the frame a list of files (ADR 0005): the tree then shows
 * the list, at its display paths, and each viewer can switch to all files,
 * where the file shown is selected at its real path.
 */
export function FileFrame({ frame, readOnly }: { frame: FileFrameData; readOnly: boolean }) {
  const room = useRoom();
  const file = useFile(frame.path);
  const allPaths = useTree();
  const previewable = hasPreview(frame.path);
  const scratch = frame.path.startsWith(SCRATCH_PREFIX);
  const view = fileView(frame);
  // `view` guests don't get the tree (ADR 0002), only a list.
  const canBrowse = !readOnly;
  // Every board change makes new frame objects: key the list by its content.
  const listKey = frame.files?.length ? JSON.stringify(frame.files) : "";
  const list = useMemo<FileEntry[] | null>(() => (listKey ? JSON.parse(listKey) : null), [listKey]);
  const [allFiles, setAllFiles] = useState(false);
  const showList = !!list && (!allFiles || !canBrowse);
  const [treeOpen, setTreeOpen] = useState((canBrowse && !frame.path) || !!list);
  const tree = useRef<PanelImperativeHandle>(null);

  // An agent gave the frame a list: show it.
  const hadList = useRef(!!list);
  useEffect(() => {
    if (list && !hadList.current) {
      setAllFiles(false);
      if (tree.current) openTree(tree.current);
    }
    hadList.current = !!list;
  }, [list]);

  const toggleTree = () => {
    if (tree.current?.isCollapsed()) openTree(tree.current);
    else tree.current?.collapse();
  };

  // Stable, so the tree does not re-render with every frame change.
  const latest = useRef(frame);
  useEffect(() => {
    latest.current = frame;
  });
  const show = useCallback(
    (path: string, lines: LineRange | null, title: string, newFrame: boolean) => {
      const { id, w, h, files } = latest.current;
      if (newFrame) {
        const { rect, patches } = placeNew(
          allFrames(room.doc),
          { anchor: id, side: "right" },
          {
            w,
            h,
          },
        );
        addFrame(room.doc, { type: "file", path, title, lines, ...rect }, patches);
      } else
        updateFrame(room.doc, id, {
          path,
          view: null,
          lines,
          // A list's frame keeps the title its agent gave it.
          ...(!files?.length && { title }),
        });
    },
    [room.doc],
  );
  const open = useCallback(
    (path: string, newFrame: boolean) => show(path, null, basename(path), newFrame),
    [show],
  );
  const openEntry = useCallback(
    (display: string, newFrame: boolean) => {
      const entry = latest.current.files?.find((e) => e.display === display);
      if (entry) show(entry.path, entry.lines ?? null, basename(display), newFrame);
    },
    [show],
  );
  // Comments (ADR 0006): the frame's, whatever file it shows.
  const comments = useComments(room.doc, frame.id);
  const me = useMemo<Editor>(
    () => ({ kind: "person", id: room.authorId, host: room.isHost }),
    [room],
  );
  const text = file?.kind === "text" ? file.text : file?.kind === "missing" ? "" : null;
  const counts = useMemo(() => {
    const byPath = new Map<string, number>();
    for (const comment of comments) byPath.set(comment.path, (byPath.get(comment.path) ?? 0) + 1);
    return byPath;
  }, [comments]);
  const [commentedOnly, setCommentedOnly] = useState(false);
  const filtering = commentedOnly && counts.size > 0;

  // The host moves the shown file's comments along as it changes.
  const shownIds = comments
    .filter((c) => c.path === frame.path)
    .map((c) => c.id)
    .join();
  useEffect(() => {
    if (room.isHost && frame.path && text !== null) settle(room.doc, frame.id, frame.path, text);
  }, [room, frame.id, frame.path, text, shownIds]);

  const openComment = useCallback(
    (comment: Comment) => show(comment.path, rangeOf(comment), basename(comment.path), false),
    [show],
  );

  const listPaths = useMemo(() => list?.map((entry) => entry.display), [list]);
  const shownList = useMemo(
    () =>
      filtering
        ? listPaths?.filter((display) => {
            const entry = list?.find((e) => e.display === display);
            return !!entry && counts.has(entry.path);
          })
        : listPaths,
    [filtering, list, listPaths, counts],
  );
  const shownAll = useMemo(
    () => (filtering && allPaths ? allPaths.filter((path) => counts.has(path)) : allPaths),
    [filtering, allPaths, counts],
  );
  /** A row's badges, the comment count in colour (`FileTree`). */
  const badgeOf = useCallback(
    (labels: ReadonlyArray<string | false | null | undefined>, path: string) => {
      const text = labels.filter(Boolean).join(" · ");
      const n = counts.get(path);
      if (!n) return text || null;
      const count = `● ${n}`;
      return {
        text: text ? `${text} · ${count}` : count,
        title: `${n} comment${n === 1 ? "" : "s"}`,
        parts: [
          ...(text ? [{ text: `${text} · ` }] : []),
          { text: count, color: "var(--status-ready, #eab308)" },
        ],
      };
    },
    [counts],
  );
  const badge = useCallback(
    (display: string) => {
      const entry = list?.find((e) => e.display === display);
      if (!entry) return null;
      return badgeOf(
        [
          entry.lines &&
            (entry.lines.start === entry.lines.end
              ? `L${entry.lines.start}`
              : `L${entry.lines.start}–${entry.lines.end}`),
          entry.path.startsWith(SCRATCH_PREFIX) && "scratch",
        ],
        entry.path,
      );
    },
    [list, badgeOf],
  );
  const allBadge = useCallback((path: string) => badgeOf([], path), [badgeOf]);
  const badgeKey = [...counts].join();
  const selectedEntry = list ? (entryFor(list, frame.path, frame.lines)?.display ?? "") : "";

  const body = (
    <FileBody
      path={frame.path}
      file={file}
      view={view}
      empty={canBrowse ? "tree" : "none"}
      source={(text) => (
        <CommentedSource
          frameId={frame.id}
          path={frame.path}
          text={text}
          lines={frame.lines}
          comments={comments}
          me={me}
          readOnly={readOnly}
        />
      )}
      preview={(text) => <MarkdownPreview frameId={frame.id} path={frame.path} text={text} />}
      html={(text) => <HtmlPreview frameId={frame.id} path={frame.path} html={text} />}
    />
  );

  const hasTree = canBrowse || !!list;
  const toolbar = (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b px-1.5" data-tree-toolbar="">
      <ToolbarButton title="Hide files" onClick={toggleTree}>
        <PanelLeftClose />
      </ToolbarButton>
      {list && canBrowse && (
        <ToolbarButton
          title={showList ? "Show all files" : "Show the list"}
          onClick={() => setAllFiles(showList)}
        >
          {showList ? <FolderTree /> : <ListTree />}
        </ToolbarButton>
      )}
      <span className="flex-1" />
      {counts.size > 0 && (
        <ToolbarButton
          title={filtering ? "Show every file" : "Only files with comments"}
          pressed={filtering}
          onClick={() => setCommentedOnly(!filtering)}
        >
          <MessageSquare />
        </ToolbarButton>
      )}
    </div>
  );

  return (
    <FrameShell
      frame={frame}
      readOnly={readOnly}
      status={
        <span
          className="text-muted-foreground max-w-[45%] truncate font-mono text-[11px]"
          title={
            scratch
              ? `${frame.path}: written by an agent for the board, kept by canvas outside the project`
              : frame.path
          }
        >
          {frame.path}
        </span>
      }
      actions={
        <>
          {comments.length > 0 && <CommentsButton comments={comments} onOpen={openComment} />}
          {previewable && (
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
          {hasTree && !treeOpen && (
            <Button
              size="icon-sm"
              variant="ghost"
              className="size-6"
              title="Show files"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={toggleTree}
            >
              <PanelLeftOpen />
            </Button>
          )}
        </>
      }
    >
      {hasTree ? (
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel
            panelRef={tree}
            collapsible
            collapsedSize={0}
            minSize={`${TREE_MIN}`}
            maxSize="60"
            defaultSize={treeOpen ? `${TREE_DEFAULT}` : "0"}
            onResize={() => setTreeOpen(!tree.current?.isCollapsed())}
            className="bg-muted/30"
          >
            {/* Collapsed panels keep their content laid out; don't let it leak. */}
            {treeOpen && (
              <div className="flex h-full flex-col">
                {toolbar}
                <div className="min-h-0 flex-1">
                  {showList ? (
                    <FileTree
                      key={filtering ? "list-commented" : "list"}
                      paths={shownList!}
                      selected={selectedEntry}
                      onOpen={openEntry}
                      order={listPaths}
                      badge={badge}
                      badgeKey={badgeKey}
                      readOnly={readOnly}
                    />
                  ) : (
                    <FileTree
                      key={filtering ? "all-commented" : "all"}
                      paths={shownAll}
                      selected={frame.path}
                      onOpen={open}
                      badge={allBadge}
                      badgeKey={badgeKey}
                      expandAll={filtering}
                    />
                  )}
                </div>
              </div>
            )}
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

/**
 * Expand a collapsed tree. A tree that was never open has no size to go back
 * to, and would open at its minimum, names cut off: open it at its default.
 */
function openTree(panel: PanelImperativeHandle) {
  panel.expand();
  if (panel.getSize().asPercentage < TREE_MIN + 0.5) panel.resize(`${TREE_DEFAULT}`);
}
const TREE_MIN = 18;
const TREE_DEFAULT = 32;

function ToolbarButton({
  title,
  pressed,
  onClick,
  children,
}: {
  title: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className={cn("size-6 [&_svg]:size-3.5", pressed && "bg-accent text-foreground")}
      title={title}
      aria-pressed={pressed}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/**
 * A file's source with the frame's comments on it, below their last line;
 * outdated ones above the first. Anyone who may edit the board comments from
 * the gutter's "+" (on the lines selected, if any).
 */
function CommentedSource({
  frameId,
  path,
  text,
  lines,
  comments,
  me,
  readOnly,
}: {
  frameId: string;
  path: string;
  text: string;
  lines: LineRange | null | undefined;
  comments: ReadonlyArray<Comment>;
  me: Editor;
  readOnly: boolean;
}) {
  const room = useRoom();
  // A comment being written, on the file it was started on.
  const [pending, setPending] = useState<(LineRange & { path: string }) | null>(null);
  const draft = pending?.path === path ? pending : null;
  const setDraft = useCallback(
    (range: LineRange | null) => setPending(range && { ...range, path }),
    [path],
  );

  // Placed here against the text we have: the host's `settle` may still be on its way.
  const placed = useMemo(
    () =>
      comments
        .filter((comment) => comment.path === path)
        .map((comment) => ({ comment, at: relocate(text, comment.quote, comment.start) })),
    [comments, path, text],
  );
  const notes = useMemo(() => {
    const at = new Set(placed.map(({ at }) => at?.end ?? 0));
    if (draft) at.add(draft.end);
    return [...at].sort((a, b) => a - b);
  }, [placed, draft]);

  const card = (comment: Comment, outdated: boolean) => (
    <CommentCard
      key={comment.id}
      comment={outdated ? { ...comment, outdated: true } : comment}
      canChange={!readOnly && mayChange(me, comment)}
      onEdit={(body) => editComment(room.doc, frameId, comment.id, body)}
      onDelete={() => removeComment(room.doc, frameId, comment.id)}
    />
  );
  const renderNote = (line: number) => (
    <div className="flex flex-col gap-1.5 px-2 py-1.5" data-comment-line={line}>
      {placed
        .filter(({ at }) => (at?.end ?? 0) === line)
        .map(({ comment, at }) => card(at ? { ...comment, ...at } : comment, !at))}
      {draft?.end === line && (
        <CommentComposer
          onCancel={() => setDraft(null)}
          onSave={(body) => {
            const quote = quoteOf(text, draft.start, draft.end);
            if (quote === null) return setDraft(null);
            addComment(room.doc, frameId, {
              path,
              start: draft.start,
              end: draft.end,
              quote,
              body,
              author: {
                kind: "person",
                id: room.authorId,
                name: room.identity.name,
                color: room.identity.color,
              },
            });
            setDraft(null);
          }}
        />
      )}
    </div>
  );

  return (
    <div data-frame-body="" className="h-full select-text">
      <CodeView
        frameId={frameId}
        path={path}
        text={text}
        wrap={isMarkdown(path)}
        lines={lines}
        notes={notes}
        renderNote={renderNote}
        onGutter={readOnly ? undefined : setDraft}
      />
    </div>
  );
}

function FileBody({
  path,
  file,
  view,
  empty,
  source,
  preview,
  html,
}: {
  path: string;
  file: FileContent | undefined;
  view: FileView;
  empty: "tree" | "none";
  source: (text: string) => React.ReactNode;
  preview: (text: string) => React.ReactNode;
  html: (text: string) => React.ReactNode;
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
      if (view === "preview" && isHtml(path)) return html(file.text);
      return view === "preview" && isMarkdown(path) ? preview(file.text) : source(file.text);
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
/** Marks each heading with its slug, for links to it (`#install`, ADR 0007). */
function slugHeadings() {
  return (tree: Root) => {
    const slugger = new Slugger();
    const visit = (nodes: ReadonlyArray<Root["children"][number] | ElementContent>) => {
      for (const node of nodes) {
        if (node.type !== "element") continue;
        if (/^h[1-6]$/.test(node.tagName))
          node.properties = { ...node.properties, dataHeading: slugger.slug(textOf(node)) };
        else visit(node.children);
      }
    };
    visit(tree.children);
  };
}
const textOf = (node: ElementContent): string =>
  node.type === "text" ? node.value : "children" in node ? node.children.map(textOf).join("") : "";

const REHYPE = [keyBlocks, slugHeadings];
const REMARK = [remarkGfm];

function MarkdownPreview({ frameId, path, text }: { frameId: string; path: string; text: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  useFollowScroll(
    frameId,
    `preview:${path}`,
    () => scroller.current && domSurface(scroller.current),
    text,
  );
  // A heading a link sent us to: scrolled to, for us.
  const reveal = useReveal(frameId, path);
  useEffect(() => {
    const box = scroller.current;
    if (!reveal?.heading || !box) return;
    const heading = box.querySelector(`[data-heading="${CSS.escape(reveal.heading)}"]`);
    if (heading) {
      const scale = box.getBoundingClientRect().height / box.offsetHeight || 1;
      const offset = heading.getBoundingClientRect().top - box.getBoundingClientRect().top;
      box.scrollTop += offset / scale - 12;
    }
    revealed(frameId, reveal);
  }, [reveal, frameId, text]);
  // Relative links are the file's own.
  const scope = useMemo(() => ({ frame: frameId, file: path }), [frameId, path]);
  return (
    <div ref={scroller} data-frame-body="" className="h-full overflow-auto">
      <div data-sel-root={frameId} data-sel-path={path} className="relative p-4">
        <div className="prose-canvas text-sm select-text">
          <LinkScope value={scope}>
            <Markdown
              remarkPlugins={REMARK}
              rehypePlugins={REHYPE}
              components={MARKDOWN_LINKS}
              urlTransform={urlTransform}
            >
              {text}
            </Markdown>
          </LinkScope>
        </div>
        <RemoteSelections frameId={frameId} path={path} version={text} />
      </div>
    </div>
  );
}

/**
 * An HTML file of the shared set, rendered (ADR 0004). Its scripts run, in a
 * sandbox without `allow-same-origin`: an opaque origin that cannot reach
 * the web app's storage (the room key, the host token), navigate the board
 * or open windows. Relative assets don't resolve — one-file pages.
 * The page keeps its own scroll; selections don't reach it.
 *
 * Its links do (ADR 0007): a script we add hands every click a person makes
 * on one to us, and we follow it as a link in markdown. Another HTML file
 * opens in this frame.
 */
function HtmlPreview({ frameId, path, html }: { frameId: string; path: string; html: string }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const go = useGo();
  const base = useLinkBase();
  // A token per page: the bridge's posts carry it, the page's own scripts can't (`link-bridge.ts`).
  const [token] = useState(() => crypto.randomUUID());
  const doc = useMemo(() => withLinkBridge(html, token), [html, token]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow) return;
      const href = bridgedLink(event.data, token);
      if (href === null) return;
      const link = parseLink(href, { cwd: base.cwd, file: path });
      if (!link) return;
      const page = link.kind === "board" && !link.target.frame && isHtml(link.target.path ?? "");
      go(link, { from: frameId, inPlace: page });
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [go, base.cwd, path, frameId, token]);
  return (
    <iframe
      ref={iframe}
      title={path}
      srcDoc={doc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      // Pointer events off while the board is being dragged, or the iframe swallows them.
      className="size-full bg-white [[data-grabbing]_&]:pointer-events-none"
    />
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
