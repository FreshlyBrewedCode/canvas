import { Bot, FileCode, Globe, MessageSquare, SquareTerminal } from "lucide-react";
import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { defaultUrlTransform, type Components } from "react-markdown";
import type * as Y from "yjs";

import { framesOf, readFrame, type FrameType } from "@/lib/board";
import {
  formatHash,
  parseCodeRef,
  parseLink,
  type Link,
  type LinkBase,
  type LinkTarget,
} from "@/lib/board-link";
import type { NavigateOptions } from "@/lib/navigate";
import { useRoom, useRoomState, useTree } from "@/lib/room-context";
import { cn } from "@/lib/utils";
import { SCRATCH_PREFIX } from "../../shared/board-tools";

/** Follow a link: the board's, from `Board` (ADR 0007). */
export type Go = (link: Link, options?: NavigateOptions) => void;
const GoContext = createContext<Go>(() => {});
export const GoProvider = GoContext.Provider;
export const useGo = () => useContext(GoContext);

/** Where links sit: the frame (new frames go beside it) and the file, for relative paths. */
export interface LinkScopeValue {
  readonly frame: string | null;
  readonly file?: string | null;
}
const ScopeContext = createContext<LinkScopeValue>({ frame: null });
export const LinkScope = ScopeContext.Provider;

/** What relative and absolute paths are read against here. */
export function useLinkBase(): LinkBase & LinkScopeValue {
  const room = useRoomState();
  const scope = useContext(ScopeContext);
  const cwd = room.roomState?.cwd ?? null;
  return useMemo(() => ({ ...scope, cwd }), [scope, cwd]);
}

/** react-markdown drops hrefs of schemes it doesn't know: keep scratch paths. */
export const urlTransform = (url: string) =>
  url.startsWith(SCRATCH_PREFIX) ? url : defaultUrlTransform(url);

/**
 * Links and inline code in markdown, as places on the board: a link to a
 * frame, a file or lines of it is a chip that goes there; inline code that
 * names a file that exists (`src/a.ts:42`) is one too. Web links open in a
 * new tab — never in this one, which holds the board.
 */
export const MARKDOWN_LINKS: Partial<Components> = {
  a: ({ href, children }) => <MarkdownLink href={href ?? ""}>{children}</MarkdownLink>,
  code: ({ className, children }) => {
    const text = typeof children === "string" ? children : null;
    // Blocks end in a newline; a language class means a block too.
    if (className || text === null || text.includes("\n"))
      return <code className={className}>{children}</code>;
    return <CodeRef text={text} />;
  },
};

function MarkdownLink({ href, children }: { href: string; children: React.ReactNode }) {
  const base = useLinkBase();
  const link = useMemo(() => parseLink(href, base), [href, base]);
  if (!link)
    return (
      <span className="text-muted-foreground underline decoration-dotted" title={href}>
        {children}
      </span>
    );
  if (link.kind === "web")
    return (
      <a href={link.url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  return <BoardChip target={link.target}>{children}</BoardChip>;
}

function CodeRef({ text }: { text: string }) {
  const base = useLinkBase();
  const target = useMemo(() => parseCodeRef(text, base), [text, base]);
  const found = useFound(target);
  if (!target || !found) return <code>{text}</code>;
  return (
    <BoardChip target={target} code>
      {text}
    </BoardChip>
  );
}

/** A place on the board, to click to: struck through if it isn't there. */
export function BoardChip({
  target,
  code,
  children,
}: {
  target: LinkTarget;
  code?: boolean;
  children: React.ReactNode;
}) {
  const go = useGo();
  const scope = useContext(ScopeContext);
  const found = useFound(target);
  const Icon = target.comment
    ? MessageSquare
    : found && found !== true
      ? FRAME_ICONS[found.type]
      : FileCode;
  const where = target.frame
    ? `${found && found !== true ? found.title : "a closed frame"}${target.path ? ` · ${target.path}` : ""}`
    : (target.path ?? "");
  const lines = target.lines
    ? target.lines.start === target.lines.end
      ? `:${target.lines.start}`
      : `:${target.lines.start}-${target.lines.end}`
    : target.heading
      ? `#${target.heading}`
      : "";
  return (
    <a
      href={`#${formatHash(target)}`}
      data-board-link=""
      title={found ? `${where}${lines}` : `${where}${lines} — not on this board`}
      className={cn(
        "bg-muted/70 hover:bg-accent text-foreground! inline-flex max-w-full items-baseline gap-1 rounded border px-1 align-baseline no-underline! [overflow-wrap:anywhere]",
        code && "font-mono text-[0.85em]",
        !found && "text-muted-foreground! line-through",
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        if (found) go({ kind: "board", target }, { from: scope.frame });
      }}
    >
      <Icon className="size-3 shrink-0 translate-y-[0.1em] self-center" />
      <span className="min-w-0">{children}</span>
    </a>
  );
}

const FRAME_ICONS: Record<FrameType, typeof FileCode> = {
  agent: Bot,
  file: FileCode,
  browser: Globe,
  terminal: SquareTerminal,
};

/**
 * Is the place there? A frame: its type and title. A file: in the shared set
 * (true) — or, for `view` guests, who don't get the set, shown by a frame.
 */
function useFound(target: LinkTarget | null): { type: FrameType; title: string } | boolean {
  const room = useRoom();
  const tree = useTree();
  const paths = useMemo(() => (tree ? new Set(tree) : null), [tree]);
  const frameKey = useFrameSummary(room.doc, target?.frame ?? null);
  const shown = useShown(room.doc, !paths && !target?.frame ? (target?.path ?? null) : null);
  if (!target) return false;
  if (target.frame) {
    if (!frameKey) return false;
    const [type, title] = JSON.parse(frameKey) as [FrameType, string];
    return { type, title };
  }
  if (!target.path) return false;
  return paths ? paths.has(target.path) : shown;
}

/** A frame's type and title, as a string that changes only when they do; "" if it's gone. */
function useFrameSummary(doc: Y.Doc, frameId: string | null): string {
  return useSyncExternalStore(
    (onChange) => {
      framesOf(doc).observeDeep(onChange);
      return () => framesOf(doc).unobserveDeep(onChange);
    },
    () => {
      const map = frameId ? framesOf(doc).get(frameId) : undefined;
      if (!map || !frameId) return "";
      const frame = readFrame(map, frameId);
      return JSON.stringify([frame.type, frame.title]);
    },
  );
}

/** Does any frame show `path`? */
function useShown(doc: Y.Doc, path: string | null): boolean {
  return useSyncExternalStore(
    (onChange) => {
      framesOf(doc).observeDeep(onChange);
      return () => framesOf(doc).unobserveDeep(onChange);
    },
    () => {
      if (!path) return false;
      for (const map of framesOf(doc).values()) if (map.get("path") === path) return true;
      return false;
    },
  );
}
