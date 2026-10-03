/**
 * Who occupies which frame. Everyone has at most one frame in focus: pressing
 * on a free frame claims it, pressing on the board or another frame lets it
 * go. Whoever occupies a frame drives its scroll for everyone following it.
 * An agent occupies the frame it last opened or changed until its turn ends;
 * the host's browser publishes those claims for it.
 *
 * A file frame's tree panel follows too (`TreeView`): whether it is open,
 * which tree it shows, its folders, search and scroll.
 *
 * Claims are presence, not board state: they go with whoever made them. When
 * two claim a frame at once, the earlier claim wins (ties: the lower Yjs
 * client id), and a person always wins over an agent.
 */

/** Where the occupant has scrolled a frame; `key` names what is scrolled. */
export interface FrameScroll {
  /** e.g. `thread`, `source:<path>`, `preview:<path>`, `term`: only the same view follows. */
  readonly key: string;
  readonly top: number;
  /** Scrolled to the end: followers stay at their own end, whatever its offset. */
  readonly end?: boolean;
}

/** How the occupant has a file frame's tree panel. */
export interface TreeView {
  /** Which tree the panel shows (`list`, `all`, `-commented` for commented files only); null: closed. */
  readonly panel: string | null;
  /** The panel's width, in % of the frame. */
  readonly size: number;
  /** Which tree `expanded`, `search` and `top` are of: only the same tree follows. */
  readonly of: string | null;
  /** The folders open, of those showing. */
  readonly expanded: ReadonlyArray<string>;
  readonly search: string | null;
  readonly top: number;
}

export const CLOSED_TREE: TreeView = {
  panel: null,
  size: 0,
  of: null,
  expanded: [],
  search: null,
  top: 0,
};

export interface Focus {
  readonly frameId: string;
  /** When it was claimed (ms since epoch), to settle two claims. */
  readonly since: number;
  readonly scroll: FrameScroll | null;
  /** File frames: the tree panel. */
  readonly tree?: TreeView | null;
}

/** What the host publishes for each agent that is working on a frame. */
export interface AgentClaim {
  readonly sessionId: string;
  /** The agent frame it acts as (ADR 0012, decision 3): its name is that frame's title. */
  readonly agentFrame?: string;
  /** The frame it works on. */
  readonly frameId: string;
  readonly since: number;
}

/** The part of a peer's presence this reads. */
export interface FocusState {
  readonly user?: { readonly name: string; readonly color: string };
  readonly focus?: Focus | null;
  readonly agents?: ReadonlyArray<AgentClaim>;
}

export interface Occupant {
  /** `p:<client id>` for a person, `a:<session id>` for an agent. */
  readonly key: string;
  readonly kind: "person" | "agent";
  readonly name: string;
  readonly color: string;
  readonly since: number;
  readonly clientId: number;
  readonly scroll: FrameScroll | null;
  readonly tree: TreeView | null;
}

/** Every occupied frame and its occupant, from everyone's presence (ours included). */
export function resolveOccupants(
  states: Iterable<readonly [number, FocusState]>,
  agentName: (agentFrame: string) => string | undefined = () => undefined,
): Map<string, Occupant> {
  const occupants = new Map<string, Occupant>();
  const offer = (frameId: string, candidate: Occupant) => {
    const current = occupants.get(frameId);
    if (!current || beats(candidate, current)) occupants.set(frameId, candidate);
  };
  for (const [clientId, state] of states) {
    if (!state?.user) continue;
    if (state.focus)
      offer(state.focus.frameId, {
        key: `p:${clientId}`,
        kind: "person",
        name: state.user.name,
        color: state.user.color,
        since: state.focus.since,
        clientId,
        scroll: state.focus.scroll,
        tree: state.focus.tree ?? null,
      });
    for (const claim of state.agents ?? [])
      offer(claim.frameId, {
        key: `a:${claim.sessionId}`,
        kind: "agent",
        name: agentName(claim.agentFrame ?? claim.sessionId) ?? "agent",
        color: agentColor(claim.sessionId),
        since: claim.since,
        clientId,
        scroll: null,
        tree: null,
      });
  }
  return occupants;
}

function beats(a: Occupant, b: Occupant): boolean {
  if (a.kind !== b.kind) return a.kind === "person";
  return a.since < b.since || (a.since === b.since && a.clientId < b.clientId);
}

/**
 * Agents' colours: presence hues, picked by session id. Not yellow: that is
 * the highlight of the lines an agent points a file frame at.
 */
const AGENT_COLORS = ["#14b8a6", "#a855f7", "#22c55e", "#ec4899", "#3b82f6"];

export function agentColor(sessionId: string): string {
  let hash = 0;
  for (const char of sessionId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AGENT_COLORS[hash % AGENT_COLORS.length]!;
}
