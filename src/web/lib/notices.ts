import type { GuestAccess } from "../../shared/protocol";
import type { Knock } from "./admission";
import type { Approval, OwnRequest } from "./room";

/**
 * What waits on someone, for the top bar's inbox: a view over the room's own
 * state, never a store of its own. Each source says when it is over (a
 * knocker leaves, a request is answered, a turn goes on), so a notice can't
 * outlive its cause.
 *
 * Host: knocks, guests' requests, agents blocked on a permission — they wait
 * on us. Guest: agents waiting for the host, and our own requests until the
 * host answers them.
 */
export type Notice =
  | { readonly kind: "knock"; readonly id: string; readonly knock: Knock }
  | {
      readonly kind: "approval";
      readonly id: string;
      readonly approval: Approval;
    }
  | {
      readonly kind: "agent";
      readonly id: string;
      readonly frame: WaitingFrame;
    }
  | {
      readonly kind: "request";
      readonly id: string;
      readonly request: OwnRequest;
    };

export interface WaitingFrame {
  readonly id: string;
  readonly title: string;
}

export interface NoticeSources {
  readonly isHost: boolean;
  readonly knocks: ReadonlyArray<Knock>;
  readonly approvals: ReadonlyArray<Approval>;
  /** Agent frames blocked on a permission, while the host is there to answer. */
  readonly waiting: ReadonlyArray<WaitingFrame>;
  /** Guests: ours, on their way to the host. */
  readonly requests: ReadonlyArray<OwnRequest>;
  /** Guests: what the host lets us do; only `edit` waits for an approval. */
  readonly access: GuestAccess | null;
}

/** Every notice, people before agents, each kind in the order it came. */
export function notices(sources: NoticeSources): Notice[] {
  const agents = sources.waiting.map((frame): Notice => ({
    kind: "agent",
    id: `agent:${frame.id}`,
    frame,
  }));
  if (sources.isHost)
    return [
      ...sources.knocks.map((knock): Notice => ({
        kind: "knock",
        id: `knock:${knock.peerId}`,
        knock,
      })),
      ...sources.approvals.map((approval): Notice => ({
        kind: "approval",
        id: `approval:${approval.id}`,
        approval,
      })),
      ...agents,
    ];
  // A trusted guest's requests run at once: nothing to wait for.
  const requests =
    sources.access === "edit"
      ? sources.requests.map((request): Notice => ({
          kind: "request",
          id: `request:${request.id}`,
          request,
        }))
      : [];
  return [...requests, ...agents];
}

/** At most this many arrival cards over the board; the rest wait in the inbox. */
export const MAX_CARDS = 3;

/**
 * The cards announcing arrivals over the board: knocks and guests' requests,
 * until answered or put off for later (`later`), at most `max`. Agents have
 * their own outline and edge markers.
 */
export function arrivals(
  all: ReadonlyArray<Notice>,
  later: ReadonlySet<string>,
  max = MAX_CARDS,
): { readonly cards: Notice[]; readonly more: number } {
  const pending = all.filter(
    (n) => (n.kind === "knock" || n.kind === "approval") && !later.has(n.id),
  );
  return {
    cards: pending.slice(0, max),
    more: pending.length - Math.min(pending.length, max),
  };
}
