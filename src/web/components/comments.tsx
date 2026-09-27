import { Bot, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { MARKDOWN_LINKS, urlTransform } from "@/components/board-link";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import type { Comment } from "@/lib/comments";
import { cn } from "@/lib/utils";

const REMARK = [remarkGfm];

/** A body's text for a one-line preview: markdown's marks dropped. */
const plain = (markdown: string) =>
  markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+|^\s*(#+|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

const linesLabel = ({ start, end }: { start: number; end: number }) =>
  start === end ? `L${start}` : `L${start}–${end}`;

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** Its author, by colour and name; agents by their frame's title. */
function Author({ comment }: { comment: Comment }) {
  const { author } = comment;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {author.kind === "agent" ? (
        <Bot className="text-muted-foreground size-3.5 shrink-0" />
      ) : (
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: author.color }} />
      )}
      <span className="truncate font-medium">{author.name}</span>
    </span>
  );
}

function Body({ text }: { text: string }) {
  return (
    <div className="prose-canvas text-xs select-text">
      <Markdown remarkPlugins={REMARK} components={MARKDOWN_LINKS} urlTransform={urlTransform}>
        {text}
      </Markdown>
    </div>
  );
}

/**
 * One comment, below its last line in the source; an outdated one shows the
 * lines it was about. Its author (or the host) can edit and delete it.
 */
export function CommentCard({
  comment,
  canChange,
  onEdit,
  onDelete,
}: {
  comment: Comment;
  canChange: boolean;
  onEdit: (body: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <CommentComposer
        initial={comment.body}
        label="Save"
        onSave={(body) => {
          onEdit(body);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  return (
    <article
      data-comment={comment.id}
      className="bg-popover group/comment rounded-md border px-2.5 py-2 font-sans"
    >
      <header className="text-muted-foreground mb-1 flex items-center gap-2 text-[11px]">
        <Author comment={comment} />
        <span className="shrink-0">{linesLabel(comment)}</span>
        {comment.outdated && <Outdated />}
        <span className="shrink-0" title={new Date(comment.edited ?? comment.at).toLocaleString()}>
          {ago(comment.at)}
          {comment.edited && " · edited"}
        </span>
        <span className="flex-1" />
        {canChange && (
          <span className="flex gap-0.5 opacity-0 group-hover/comment:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              title="Edit comment"
              className="hover:text-foreground rounded p-0.5"
              onClick={() => setEditing(true)}
            >
              <Pencil className="size-3" />
            </button>
            <button
              type="button"
              title="Delete comment"
              className="hover:text-destructive rounded p-0.5"
              onClick={onDelete}
            >
              <Trash2 className="size-3" />
            </button>
          </span>
        )}
      </header>
      {comment.outdated && (
        <pre className="text-muted-foreground bg-muted/50 mb-1.5 max-h-24 overflow-auto rounded px-2 py-1 font-mono text-[11px] whitespace-pre">
          {comment.quote}
        </pre>
      )}
      <Body text={comment.body} />
    </article>
  );
}

/** Writing a comment, or editing one: ⌘/Ctrl-Enter saves, Escape cancels. */
export function CommentComposer({
  initial = "",
  label = "Comment",
  onSave,
  onCancel,
}: {
  initial?: string;
  label?: string;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initial);
  const save = () => body.trim() && onSave(body.trim());
  return (
    <div data-comment-composer="" className="bg-popover rounded-md border p-2 font-sans">
      <textarea
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened by a click to write here
        autoFocus
        aria-label="Comment"
        placeholder="Comment on these lines… (markdown)"
        className="bg-background focus-visible:ring-ring/50 min-h-16 w-full resize-y rounded border px-2 py-1.5 text-xs outline-none focus-visible:ring-2"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") onCancel();
        }}
      />
      <div className="mt-1.5 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" className="h-6 px-2 text-xs" disabled={!body.trim()} onClick={save}>
          {label}
        </Button>
      </div>
    </div>
  );
}

/**
 * The frame's comments, from its header: all of them, by file. Picking one
 * opens its file at its lines.
 */
export function CommentsButton({
  comments,
  onOpen,
}: {
  comments: ReadonlyArray<Comment>;
  onOpen: (comment: Comment) => void;
}) {
  const [open, setOpen] = useState(false);
  const byPath = Map.groupBy(comments, (comment) => comment.path);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-comments-button=""
          title={`${comments.length} comment${comments.length === 1 ? "" : "s"}`}
          className="hover:bg-accent text-muted-foreground hover:text-foreground flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px]"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <MessageSquare className="size-3.5" />
          {comments.length}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-96 w-80 overflow-y-auto p-1"
        data-comments-popover=""
        // Portalled, but React bubbles it to the header, which would start a drag.
        onPointerDown={(event) => event.stopPropagation()}
      >
        {[...byPath].map(([path, list]) => (
          <section key={path} className="py-1">
            <h3 className="text-muted-foreground truncate px-2 py-1 font-mono text-[11px]">
              {path}
            </h3>
            {list.map((comment) => (
              <button
                key={comment.id}
                type="button"
                data-comment-link={comment.id}
                className="hover:bg-accent w-full rounded-md px-2 py-1.5 text-left text-xs"
                onClick={() => {
                  onOpen(comment);
                  setOpen(false);
                }}
              >
                <span className="text-muted-foreground mb-0.5 flex items-center gap-2 text-[11px]">
                  <Author comment={comment} />
                  <span className="shrink-0">{linesLabel(comment)}</span>
                  {comment.outdated && <Outdated />}
                </span>
                <span className="line-clamp-2">{plain(comment.body)}</span>
              </button>
            ))}
          </section>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function Outdated({ className }: { className?: string }) {
  return (
    <span
      title="Its lines have changed since: it no longer shows in the file"
      className={cn("shrink-0 rounded bg-amber-500/15 px-1 text-amber-500", className)}
    >
      outdated
    </span>
  );
}
