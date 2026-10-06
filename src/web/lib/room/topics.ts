/**
 * What changed in a room, for whoever renders it: every part of the room
 * (`room.ts`) says so here, and components subscribe by topic.
 */

export type Topic =
  | "room"
  /** Host: guests' requests to approve. Guests: their own, until answered. */
  | "approvals"
  /** Host: the member list and the knocks. */
  | "members"
  | "connection"
  | "peers"
  | "focus"
  | "tree"
  /** Any session's status, and what each kind of agent offers a new session. */
  | "sessions"
  | `session:${string}`
  | `term:${string}`
  | `file:${string}`;

/** Listeners by topic; each is called in the order it subscribed. */
export class Emitter {
  private readonly listeners = new Map<Topic, Set<() => void>>();

  subscribe(topic: Topic, listener: () => void): () => void {
    let set = this.listeners.get(topic);
    if (!set) this.listeners.set(topic, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  emit(topic: Topic) {
    for (const listener of this.listeners.get(topic) ?? []) listener();
  }
}
