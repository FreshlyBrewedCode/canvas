/**
 * A file frame's comments (ADR 0006), in the board doc:
 *
 *   comments:<frameId>  Y.Map<commentId, Comment>
 *
 * They belong to the frame, not to a file: they stay while the frame shows
 * other files, and go with it. Each names the file and lines it is about,
 * the file at its address (ADR 0013): absent, the board's own runtime and
 * its working dir.
 * Only the host moves comments as their files change (`settle`), so peers
 * never race to write the same move.
 */

import { useSyncExternalStore } from "react";
import * as Y from "yjs";

import { sameAddress, type UncheckedAddress } from "../../shared/address";
import { relocate } from "../../shared/comments";
import type { LineRange } from "./board";

export type CommentAuthor =
  | {
      readonly kind: "person";
      /** The browser's fingerprint (`identity-key.ts`): says whose a comment is across renames and reloads. */
      readonly id: string;
      readonly name: string;
      readonly color: string;
    }
  | {
      readonly kind: "agent";
      /** The agent's frame. */
      readonly frame: string;
      readonly name: string;
    };

export interface Comment {
  readonly id: string;
  /** The runtime and root of its file; absent: the board's own, its working dir. */
  readonly runtime?: string;
  readonly root?: string;
  /** Root-relative, or a scratch file. */
  readonly path: string;
  /** Where its lines were last seen (1-based, inclusive). */
  readonly start: number;
  readonly end: number;
  /** The lines as they read when it was written. */
  readonly quote: string;
  /** Markdown. */
  readonly body: string;
  readonly author: CommentAuthor;
  /** When it was written, and last edited (ms). */
  readonly at: number;
  readonly edited?: number;
  /** Its lines are gone from the file. */
  readonly outdated?: boolean;
}

/** Who wants to change a comment. */
export type Editor =
  | { readonly kind: "person"; readonly id: string; readonly host: boolean }
  | { readonly kind: "agent" };

/**
 * People change their own comments, the host everyone's; agents any agent's,
 * never a person's. Board writes aren't checked by the host (ADR 0001), so
 * this holds for the app as shipped, not against a forged client.
 */
export function mayChange(editor: Editor, comment: Comment): boolean {
  if (editor.kind === "agent") return comment.author.kind === "agent";
  return editor.host || (comment.author.kind === "person" && comment.author.id === editor.id);
}

export const commentsOf = (doc: Y.Doc, frameId: string) =>
  doc.getMap<Comment>(`comments:${frameId}`);

/** A frame's comments by file, then line, then age. */
export function readComments(doc: Y.Doc, frameId: string): Comment[] {
  return [...commentsOf(doc, frameId).values()].sort(
    (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.start - b.start || a.at - b.at,
  );
}

export function addComment(
  doc: Y.Doc,
  frameId: string,
  comment: Omit<Comment, "id" | "at">,
): Comment {
  const full = { ...comment, id: crypto.randomUUID().slice(0, 8), at: Date.now() };
  commentsOf(doc, frameId).set(full.id, full);
  return full;
}

export function editComment(doc: Y.Doc, frameId: string, id: string, body: string): void {
  const map = commentsOf(doc, frameId);
  const comment = map.get(id);
  if (comment) map.set(id, { ...comment, body, edited: Date.now() });
}

export function removeComment(doc: Y.Doc, frameId: string, id: string): void {
  commentsOf(doc, frameId).delete(id);
}

export function clearComments(doc: Y.Doc, frameId: string): void {
  const map = commentsOf(doc, frameId);
  for (const id of [...map.keys()]) map.delete(id);
}

/** Is a comment on `path` at `at`? `own`: the board's own runtime, what absent means. */
export const isOn = (
  comment: Comment,
  path: string,
  at: UncheckedAddress,
  own: string | null | undefined,
): boolean => comment.path === path && sameAddress(comment, at, own);

/**
 * Host: move the comments of `path` at `at` to where their lines are in
 * `text` now, or mark them outdated — and back, should the lines return.
 */
export function settle(
  doc: Y.Doc,
  frameId: string,
  path: string,
  text: string,
  at: UncheckedAddress = {},
  own: string | null = null,
): void {
  const map = commentsOf(doc, frameId);
  doc.transact(() => {
    for (const comment of map.values()) {
      if (!isOn(comment, path, at, own)) continue;
      const now = relocate(text, comment.quote, comment.start);
      const next = now
        ? { ...comment, ...now, outdated: undefined }
        : { ...comment, outdated: true };
      if (
        next.start !== comment.start ||
        next.end !== comment.end ||
        !!next.outdated !== !!comment.outdated
      ) {
        const { outdated, ...rest } = next;
        map.set(comment.id, outdated ? { ...rest, outdated } : rest);
      }
    }
  });
}

/** Where a comment sits; for `lines` of a file frame. */
export const rangeOf = (comment: Comment): LineRange => ({
  start: comment.start,
  end: comment.end,
});

/** An immutable snapshot per frame, rebuilt only when its comments change. */
class CommentsStore {
  private snapshot: Comment[];
  constructor(
    private readonly doc: Y.Doc,
    private readonly frameId: string,
  ) {
    this.snapshot = readComments(doc, frameId);
    commentsOf(doc, frameId).observe(() => (this.snapshot = readComments(doc, frameId)));
  }
  subscribe = (onChange: () => void) => {
    const map = commentsOf(this.doc, this.frameId);
    map.observe(onChange);
    return () => map.unobserve(onChange);
  };
  get = () => this.snapshot;
}
const stores = new WeakMap<Y.Doc, Map<string, CommentsStore>>();

export function useComments(doc: Y.Doc, frameId: string): Comment[] {
  let perDoc = stores.get(doc);
  if (!perDoc) stores.set(doc, (perDoc = new Map()));
  let store = perDoc.get(frameId);
  if (!store) perDoc.set(frameId, (store = new CommentsStore(doc, frameId)));
  return useSyncExternalStore(store.subscribe, store.get);
}
