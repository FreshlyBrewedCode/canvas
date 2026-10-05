/**
 * One board session in the browser: the Yjs doc, presence, the transport to
 * the other peers (`transport/`, ADR 0008) and — for the host — the link to
 * `canvas serve`.
 *
 * Topology. Presence (cursors, selections, frame focus) is a mesh between
 * the peers that are in: the host signs who they are (`member-list.ts`), and
 * guests send theirs only to peers on that list and take it only from them.
 * Everything with authority is a star around the host's browser:
 *
 *  - board updates: guests send theirs to the host only; the host applies
 *    what the guest's role allows and re-broadcasts. A read-only guest's
 *    edits therefore never reach anyone.
 *  - agent threads, terminals and files: only the host has them (from the
 *    server); it mirrors them to guests. A file frame's path in the board is
 *    only a request — what the server lets out is the shared set (ADR 0002).
 *  - anything that runs on the host's machine is a request to the host,
 *    checked against the requesting member's role, possibly waiting for the
 *    host to approve it.
 *
 * Guests only accept host traffic from the peer that proved it holds the
 * board's host key (see `host-key.ts`). Every guest in turn proves its
 * browser's key to the host (ADR 0011, `shared/identity.ts`), whose signed
 * member list tells everyone whose fingerprint each peer verified with.
 *
 * Admission (ADR 0011, decision 2, `admission.ts`): the guest link is an
 * invite. A guest whose key isn't a member's waits in the lobby until the
 * host lets it in; until then the host sends it nothing but its hello and
 * `lobby`, and refuses its updates, requests and presence. It isn't on the
 * member list, so no guest sends it presence or takes its own.
 *
 * Resetting the invite link (ADR 0011, decision 6, `handover.ts`): `canvas
 * serve` mints a new room; the host hands it to the members that are in,
 * sealed to each, and everyone moves there. Whoever else holds the old link —
 * the lobby, removed members — stays behind in a room nobody comes to.
 */

import { selfId } from "trystero";
import {
  addressKey,
  canonical,
  reach,
  type Address,
  type UncheckedAddress,
} from "../../shared/address";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type {
  Admission,
  AgentConfigOption,
  AgentEvent,
  AgentKind,
  FileContent,
  GuestAccess,
  GuestRead,
  GuestReply,
  GuestRequest,
  HostBroadcast,
  Member,
  MemberRole,
  RoomSecrets,
  RoomState,
  ServerToClient,
  SignedMemberList,
  SessionHead,
  SessionMeta,
  ToolImage,
  WelcomeRelay,
} from "../../shared/protocol";
import { Admissions, check, mayEdit, type Knock, type Step } from "./admission";
import {
  allFrames,
  frameReach,
  newConversation,
  showConversation,
  shownPty,
  shownSession,
  tidy,
  type AgentFrame,
  type Frame,
} from "./board";
import type { DragGhost } from "./drag";
import {
  CLOSED_TREE,
  resolveOccupants,
  type AgentClaim,
  type Focus,
  type FrameScroll,
  type Occupant,
  type TreeView,
} from "./focus";
import { runBoardTool } from "./board-tools";
import {
  boardSessions,
  framesShowing,
  mergeLog,
  nextSettings,
  place,
  promptFrame,
  Releases,
  shownSessions,
  startIn,
  unbegunOptions,
  type Placed,
} from "./sessions";
import { lastFrame } from "../../shared/sessions";
import { drawingImage, prepareDrawCall } from "./drawing-kit";
import type { ConnectionEvent, RelayInfo } from "./connection";
import { signHost, verifyHost } from "./host-key";
import { provePeer, type BrowserKey } from "./identity-key";
import { makeSealKey, openMove, sealMove, type Move, type SealedMove } from "./handover";
import { forgetPairingCode, showLink, type BoardLink, type Identity, type RelayLink } from "./link";
import { Members, nextVersion, signMembers } from "./member-list";
import {
  PeerIdentities,
  ownerStatement,
  type PeerIdentity,
  type PeerProof,
} from "../../shared/identity";
import { ServerLink, type LinkStatus } from "./server-link";
import { openTransport } from "./transport/open";
import type { Transport } from "./transport/transport";

export interface Approval {
  readonly id: string;
  readonly peerId: string;
  readonly peer: Identity;
  readonly request: GuestRequest;
  readonly resolve: (approved: boolean) => void;
}

/** What each peer publishes as presence. Positions are in board coordinates. */
export interface Presence {
  readonly user: Identity & {
    readonly colorLight: string;
    readonly peerId: string;
    readonly host: boolean;
  };
  readonly pointer: { readonly x: number; readonly y: number } | null;
  /** The part of the board our viewport shows (throttled: peers smooth between updates). */
  readonly view: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  } | null;
  readonly selection: Selection | null;
  /** A frame or cluster we drag, for a ghost of it (`drag.ts`). */
  readonly drag?: DragGhost | null;
  /** The frame we occupy, or would if nobody else did (see `focus.ts`). */
  readonly focus: Focus | null;
  /**
   * In full screen, the frame we are on (ADR 0010, decision 8): followers go
   * full screen on it, at their own screen's size, and everyone sees us there.
   */
  readonly fullscreen?: string | null;
  /** Host only: the frames agents are working on. */
  readonly agents?: ReadonlyArray<AgentClaim>;
}

/** Someone else's presence, with the fingerprint the host verified for their peer, if any. */
export interface Peer extends Presence {
  readonly fingerprint: string | null;
}

/** A frame's occupant as one peer sees it. */
export interface FrameFocus {
  readonly occupant: Occupant | null;
  /** We occupy it. */
  readonly mine: boolean;
  /** Someone else does and we follow their scroll (we haven't scrolled away). */
  readonly following: boolean;
}

const FREE: FrameFocus = { occupant: null, mine: false, following: false };

export type Selection = TextSelection | LineSelection;

/**
 * A text range in rendered content — an agent thread, a markdown preview —
 * anchored to block keys every peer renders the same (see `selection.ts`).
 */
export interface TextSelection {
  readonly kind: "text";
  readonly frameId: string;
  /** The file, for a file frame: the selection is gone once it shows another. */
  readonly path?: string;
  readonly anchor: { readonly key: string; readonly offset: number };
  readonly focus: { readonly key: string; readonly offset: number };
}

/** Lines of a file frame's source view, 1-based and inclusive. */
export interface LineSelection {
  readonly kind: "lines";
  readonly frameId: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

/**
 * A guest's way in: `connecting` until the host says, `lobby` while it
 * waits, and `denied` or `removed` once shut out (it leaves the room).
 */
export type AdmissionStatus = "connecting" | "lobby" | "admitted" | "denied" | "removed";

type Topic =
  | "room"
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

const APP_ID = "canvas-prototype-v1";
/** Host, resetting the invite link: how long the members have to leave for the new room before we follow. */
const MOVE_WAIT_MS = 3000;
const LOG_LIMIT = 300;
const TERM_SCROLLBACK = 200_000;
const json = <T>(value: T) => value as never;
const NOT_REACHABLE = "not reachable: that is on another runtime";

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly isHost: boolean;
  /** This browser's key's fingerprint (`identity-key.ts`); also says which comments are ours. */
  readonly fingerprint: string;
  readonly selfId = selfId;

  /** The host's from the welcome; a guest's once the host lets it in. */
  roomState: RoomState | null = null;
  serverStatus: LinkStatus | null = null;
  hostOnline = false;
  /** Guests: whether the host let us in. */
  admission: AdmissionStatus = "connecting";
  /** Whether every session's head is here (the welcome's, or the host's `sessions`). */
  sessionsKnown = false;
  /** Guests: what the host lets us do; null until we are in. */
  access: GuestAccess | null = null;
  approvals: Approval[] = [];
  /** Host: the members `canvas serve` keeps; a new array on every change. */
  members: ReadonlyArray<Member> = [];
  /** Host: the fingerprints of the members trusted this session (decision 4); a new array on every change. */
  trusted: ReadonlyArray<string> = [];
  /** Host: who waits in the lobby; a new array on every change. */
  knocks: Knock[] = [];
  /** Everyone else's presence; a new array on every change. */
  peerList: Peer[] = [];
  /** What happened to the connection, and every error (`connection.ts`); a new array on every change. */
  log: ConnectionEvent[] = [];
  /** When we joined the room. */
  joinedAt: number | null = null;
  /** Host: the board's relay (ADR 0008) as `canvas serve` set it up for this tab. */
  private relaySetup: WelcomeRelay | null = null;

  /*
   * What we mirror is keyed by address (ADR 0013, decision 7; `addressKey`):
   * the bare id for the board's own runtime's, the address with it otherwise
   * — two runtimes may have the same session or PTY id.
   */
  private readonly sessions = new Map<string, MirroredSession>();
  /** The settings each kind of agent offers a new session (ADR 0012), by runtime and kind. */
  private readonly kinds = new Map<string, Mirrored<{ readonly options: AgentOptions }>>();
  /** Host: which sessions' agents may stop, as frames stop showing them (ADR 0012). */
  private readonly releases = new Releases();
  /**
   * Guests: the sessions frames showed when the host last sent every head
   * (their logs come with them), then since; a session newly shown whose log
   * we lack is asked for. Null until the heads are here.
   */
  private shownHere: Set<string> | null = null;
  /** Guests: sessions whose log we asked the host for, until it comes. */
  private readonly asked = new Set<string>();
  /** Each runtime's sessions' metas, the last active first; rebuilt after a change. */
  private readonly metaLists = new Map<string, SessionMeta[]>();
  private readonly terminals = new Map<string, Mirrored<{ readonly data: string }>>();
  private readonly files = new Map<string, Mirrored<{ readonly file: FileContent }>>();
  /** Each root's shared set's file list, once the host sends it (never to `view` guests). */
  private readonly trees = new Map<string, Mirrored<{ readonly paths: ReadonlyArray<string> }>>();
  private readonly listeners = new Map<Topic, Set<() => void>>();
  private readonly peerClients = new Map<string, Set<number>>();
  private readonly server: ServerLink | null = null;
  private hostPrivateKey: JsonWebKey | null = null;
  /** Host: who each guest proved to be, in this room. */
  private identities: PeerIdentities;
  /** Host: who is in, who knocks. */
  private readonly admissions = new Admissions();
  /** Guests: the peer that proved it is the host. */
  private hostPeer: string | null = null;
  /** Verified fingerprints by peer id: the host's own book, or as its member list says. */
  private fingerprints: Readonly<Record<string, string>> = {};
  /** Guests: the latest member list the host signed; whom presence goes to and comes from. */
  private memberList: Members;
  /** Guests: the last presence of peers not on the list (yet): the list may come after it. */
  private readonly heldPresence = new Map<string, Uint8Array>();
  /** Host: the member list we signed last, and its version. */
  private signedList: SignedMemberList | null = null;
  private listVersion = 0;
  private transport: Transport | null = null;
  private actions: ReturnType<Room["makeActions"]> | null = null;
  /** Paths opened with the server since the link came up. */
  private readonly watched = new Set<string>();
  private treeWatched = false;
  /**
   * Terminals opened, session logs asked for (`log:<id>`) and kinds probed
   * (`kind:<agent>`) since the server link came up.
   */
  private readonly opened = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private tidyTimer: ReturnType<typeof setTimeout> | null = null;
  private occupants = new Map<string, Occupant>();
  /** Frames we scrolled away from, with whom we stopped following there. */
  private readonly detached = new Map<string, string>();
  private readonly focusViews = new Map<string, FrameFocus>();
  /** Host: which frame each agent works on, published as our presence. */
  private agentClaims: AgentClaim[] = [];
  private relayStates = new Map<string, RelayInfo["state"]>();
  private relayWatch: ReturnType<typeof setInterval> | null = null;
  /** This page's ECDH key: a new room is sealed to it (`handover.ts`). */
  private readonly sealKey = makeSealKey();
  /** Host: invite link resets, one after the other. */
  private moving: Promise<void> = Promise.resolve();
  private current: BoardLink;
  /** Host: the room being handed over, until we are there. */
  private next: BoardLink | null = null;

  constructor(
    link: BoardLink,
    readonly identity: Identity,
    private readonly key: BrowserKey,
  ) {
    this.current = link;
    this.isHost = link.host !== null;
    this.fingerprint = key.fingerprint;
    this.identities = new PeerIdentities(link.roomId);
    this.memberList = new Members(link.roomId, link.hostPublicKey, selfId);
    this.setPresence({ pointer: null, view: null, selection: null, focus: null });
    this.doc.on("update", (update: Uint8Array, origin: unknown) =>
      this.onDocUpdate(update, origin),
    );
    this.awareness.on("change", () => {
      this.refreshPeers();
      this.onFocusChange();
    });
    this.awareness.on("update", ({ added, updated, removed }: AwarenessChange, origin: unknown) =>
      this.onAwareness([...added, ...updated, ...removed], added, origin),
    );

    if (link.host) {
      // The link's pairing code goes along until the server welcomes us once: then we are an owner.
      let pair = link.host.pair;
      this.server = new ServerLink(
        `${link.host.server}/ws`,
        async (nonce) => ({
          t: "auth",
          publicKey: key.publicKey,
          signature: await key.sign(ownerStatement(link.hostPublicKey, nonce)),
          ...(pair && { pair }),
        }),
        (message) => {
          if (message.t === "welcome" && pair) {
            pair = null;
            forgetPairingCode();
          }
          this.onServer(message);
        },
        (status) => {
          // Every retry passes through "connecting": only its outcome is news.
          if (status !== this.serverStatus && status !== "connecting")
            this.record({
              level: status === "open" ? "info" : status === "refused" ? "error" : "warn",
              source: "serve",
              text:
                status === "refused"
                  ? `canvas serve refused this browser: ${this.serverRefusal}`
                  : `canvas serve: ${status}`,
            });
          this.serverStatus = status;
          if (status === "replaced") this.stepDown();
          if (status !== "open") {
            this.watched.clear();
            this.treeWatched = false;
            this.opened.clear();
          }
          this.emit("room");
        },
      );
    } else {
      this.join();
    }
  }

  /** The room we are in: the link's, until the invite link is reset. */
  get link(): BoardLink {
    return this.current;
  }

  // -------------------------------------------------------------------------
  // subscriptions

  subscribe(topic: Topic, listener: () => void): () => void {
    let set = this.listeners.get(topic);
    if (!set) this.listeners.set(topic, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  private emit(topic: Topic) {
    // Any session's meta may have changed.
    if (topic === "sessions") this.metaLists.clear();
    for (const listener of this.listeners.get(topic) ?? []) listener();
  }

  /** The key what is at `at` named `id` is mirrored under (`addressKey`). */
  keyOf(at: UncheckedAddress, id: string): string {
    return addressKey(at, this.runtime, id);
  }

  /** The topic that says a session, a terminal or a file of `at` changed. */
  topic(kind: "session" | "term" | "file", at: UncheckedAddress, id: string): Topic {
    return `${kind}:${this.keyOf(at, id)}`;
  }

  /** A session of the runtime `at` names (absent: the board's own). */
  session(id: string, at: UncheckedAddress = {}) {
    return this.sessions.get(this.keyOf(at, id));
  }

  /** The settings a kind of agent offers a new session; undefined until known. */
  kindOptions(agent: AgentKind, at: UncheckedAddress = {}): AgentOptions | undefined {
    return this.kinds.get(this.keyOf(at, agent))?.options;
  }

  /**
   * A session's settings; for one not begun, those its frame's agent offers,
   * at the values the frame starts it with.
   */
  optionsFor(sessionId: string, at: UncheckedAddress = {}): AgentOptions | undefined {
    const session = this.session(sessionId, at);
    if (session) return session.options;
    if (reach(at, this.runtime) !== "own") return undefined;
    const frame = framesShowing(this.here(), sessionId)[0];
    return frame && unbegunOptions(this.kindOptions(frame.agent), frame);
  }

  /**
   * Every session of the board on the runtime `at` names (ADR 0012), the
   * last active first: heads only, logs come when a frame shows one. The
   * same array until one changes. `frameSessions` (`sessions.ts`) picks a frame's.
   */
  sessionMetas(at: UncheckedAddress = {}): ReadonlyArray<SessionMeta> {
    const runtime = this.keyOf({ runtime: at.runtime }, "");
    let list = this.metaLists.get(runtime);
    if (!list) {
      const metas = [...this.sessions.values()].flatMap((s) =>
        this.keyOf(s.at, "") === runtime ? [s.meta] : [],
      );
      this.metaLists.set(runtime, (list = boardSessions(metas)));
    }
    return list;
  }

  /**
   * A new conversation in an agent frame (decision 4): a fresh id it shows,
   * with the settings of the conversation it showed. Nothing runs until its
   * first prompt. A change of the board, so for whoever may edit it; the new
   * id, or undefined if there is no such agent frame.
   */
  newConversation(frameId: string): string | undefined {
    const frame = this.agentFrame(frameId);
    if (!frame) return undefined;
    const shown = this.session(shownSession(frame), frame)?.meta;
    return newConversation(this.doc, frameId, nextSettings(frame, shown));
  }

  /** An agent frame shows another of the board's sessions (decision 1); a change of the board. */
  showConversation(frameId: string, sessionId: string) {
    showConversation(this.doc, frameId, sessionId);
  }

  /**
   * Sessions blocked on a permission only the host can answer, with the
   * frame of their turn: "needs you" points there if no frame shows them
   * (`waitingFrames`, `sessions.ts`).
   */
  waitingSessions(): Array<{ readonly id: string; readonly frameId: string }> {
    // Only the board's own runtime's: the host answers those.
    return [...this.sessions.values()]
      .filter((s) => s.meta.status === "waiting" && reach(s.at, this.runtime) === "own")
      .map((s) => ({ id: s.meta.id, frameId: lastFrame(s.meta, s.events) }));
  }

  /** A PTY's output so far, of the runtime `at` names. */
  terminal(pty: string, at: UncheckedAddress = {}): string {
    return this.terminals.get(this.keyOf(at, pty))?.data ?? "";
  }

  /** A file of the runtime and root `at` names; undefined until it arrives. */
  file(path: string, at: UncheckedAddress = {}): FileContent | undefined {
    return this.files.get(this.keyOf(at, path))?.file;
  }

  /** A root's file list; null until the host sends it (never to `view` guests). */
  tree(at: UncheckedAddress = {}): ReadonlyArray<string> | null {
    return this.trees.get(this.keyOf(at, ""))?.paths ?? null;
  }

  // -------------------------------------------------------------------------
  // presence

  setPresence(patch: Partial<Omit<Presence, "user">>) {
    const current = (this.awareness.getLocalState() ?? {}) as Partial<Presence>;
    this.awareness.setLocalState({
      ...current,
      ...patch,
      user: {
        ...this.identity,
        colorLight: `${this.identity.color}33`,
        peerId: selfId,
        host: this.isHost,
      },
    });
  }

  rename(identity: Identity) {
    Object.assign(this.identity, identity);
    this.setPresence({});
  }

  // -------------------------------------------------------------------------
  // frame focus (see `focus.ts`)

  /**
   * Who occupies a frame, and whether we follow them there; the same object
   * while that holds (its `occupant.scroll` goes stale: see `occupantScroll`).
   */
  frameFocus(frameId: string): FrameFocus {
    return this.focusViews.get(frameId) ?? FREE;
  }

  /** The occupant's scroll, for following it. */
  occupantScroll(frameId: string): FrameScroll | null {
    return this.occupants.get(frameId)?.scroll ?? null;
  }

  /** The occupant's tree panel, for following it. */
  occupantTree(frameId: string): TreeView | null {
    return this.occupants.get(frameId)?.tree ?? null;
  }

  /**
   * Pressed on a frame (or, with null, on the board): claim it if nobody
   * else is there; if someone is, follow them and hold no frame ourselves.
   */
  focusFrame(frameId: string | null) {
    const mine = this.localFocus();
    if (frameId && mine?.frameId === frameId) return;
    const occupant = frameId ? this.occupants.get(frameId) : undefined;
    const taken = occupant?.kind === "person" && occupant.clientId !== this.doc.clientID;
    const focus = frameId && !taken ? { frameId, since: Date.now(), scroll: null } : null;
    if (focus || mine) this.setPresence({ focus });
  }

  /** The frame we last pressed on, if it is still ours to be in. */
  ownFrame(): string | null {
    return this.localFocus()?.frameId ?? null;
  }

  /** We occupy the frame: tell followers where we scrolled it. */
  publishScroll(frameId: string, scroll: FrameScroll) {
    const mine = this.localFocus();
    if (mine?.frameId !== frameId) return;
    const last = mine.scroll;
    if (last?.key === scroll.key && last.top === scroll.top && !!last.end === !!scroll.end) return;
    this.setPresence({ focus: { ...mine, scroll } });
  }

  /** We occupy the frame: tell followers how we have its tree panel. */
  publishTree(frameId: string, patch: Partial<TreeView>) {
    const mine = this.localFocus();
    if (mine?.frameId !== frameId) return;
    const last = mine.tree ?? CLOSED_TREE;
    const tree = { ...last, ...patch };
    // The first one always goes out: no tree is "no say", a closed one is closed.
    if (mine.tree && JSON.stringify(tree) === JSON.stringify(last)) return;
    this.setPresence({ focus: { ...mine, tree } });
  }

  /** We scrolled a frame someone else occupies: stop following them there. */
  detach(frameId: string) {
    const occupant = this.occupants.get(frameId);
    if (!occupant || this.frameFocus(frameId).mine) return;
    this.detached.set(frameId, occupant.key);
    this.refreshFocus();
  }

  /** Back to following whoever occupies the frame. */
  follow(frameId: string) {
    this.detached.delete(frameId);
    this.refreshFocus();
  }

  /**
   * Host: an agent works on a frame now, unless a person occupies it. It
   * acts as `agentFrame` (its turn's, ADR 0012 decision 3), named after it.
   */
  claimForAgent(sessionId: string, agentFrame: string, frameId: string) {
    if (!this.isHost) return;
    if (this.occupants.get(frameId)?.kind === "person") return this.releaseAgent(sessionId);
    const others = this.agentClaims.filter((c) => c.sessionId !== sessionId);
    this.agentClaims = [...others, { sessionId, agentFrame, frameId, since: Date.now() }];
    this.setPresence({ agents: this.agentClaims });
  }

  /** Host: an agent is done (its turn ended, or it closed its frame). */
  releaseAgent(sessionId: string) {
    if (!this.agentClaims.some((c) => c.sessionId === sessionId)) return;
    this.agentClaims = this.agentClaims.filter((c) => c.sessionId !== sessionId);
    this.setPresence({ agents: this.agentClaims });
  }

  private localFocus(): Focus | null {
    return (this.awareness.getLocalState() as Presence | null)?.focus ?? null;
  }

  private onFocusChange() {
    const titles = new Map(this.frames().map((f) => [f.id, f.title]));
    this.occupants = resolveOccupants(
      this.awareness.getStates() as Map<number, Presence>,
      (agentFrame) => titles.get(agentFrame),
    );
    this.refreshFocus();
    // Settle claims that lost: ours to an earlier person, an agent's to any person.
    const mine = this.localFocus();
    const lost = mine && this.occupants.get(mine.frameId)?.clientId !== this.doc.clientID;
    const bumped = this.agentClaims.filter((c) => this.occupants.get(c.frameId)?.kind === "person");
    if (lost || bumped.length)
      queueMicrotask(() => {
        if (lost) this.setPresence({ focus: null });
        for (const claim of bumped) this.releaseAgent(claim.sessionId);
      });
  }

  private refreshFocus() {
    const ids = new Set([...this.focusViews.keys(), ...this.occupants.keys()]);
    for (const frameId of ids) {
      const occupant = this.occupants.get(frameId) ?? null;
      const mine = occupant?.kind === "person" && occupant.clientId === this.doc.clientID;
      const following = !!occupant && !mine && this.detached.get(frameId) !== occupant.key;
      const last = this.focusViews.get(frameId);
      const same =
        last &&
        last.mine === mine &&
        last.following === following &&
        last.occupant?.key === occupant?.key &&
        last.occupant?.name === occupant?.name &&
        last.occupant?.color === occupant?.color;
      // Kept as is while only the scroll moves: frames re-render on who, not where.
      if (same) continue;
      if (occupant) this.focusViews.set(frameId, { occupant, mine, following });
      else this.focusViews.delete(frameId);
    }
    // Scroll changes go out too: followers read them (`occupantScroll`) on this topic.
    this.emit("focus");
  }

  private onAwareness(changed: number[], added: number[], origin: unknown) {
    if (typeof origin === "string" && origin !== "local" && origin !== "leave") {
      // Remember which Yjs clients belong to which peer, to drop them on leave
      // and to know whose fingerprint they show.
      let set = this.peerClients.get(origin);
      if (!set) this.peerClients.set(origin, (set = new Set()));
      for (const id of added) set.add(id);
      if (added.length) this.refreshPeers();
      return;
    }
    if (origin !== "local" || !this.actions) return;
    // Only to members, and (guest) once we are one: the lobby gets none of ours.
    const targets = this.isHost ? this.admissions.admitted() : this.presenceTargets();
    if (targets.length)
      void this.actions.presence.send(encodeAwarenessUpdate(this.awareness, changed), {
        target: targets,
      });
  }

  // -------------------------------------------------------------------------
  // peers (`transport/`)

  private makeActions(transport: Transport) {
    return {
      hello: transport.channel("hello"),
      identify: transport.channel("identify"),
      admission: transport.channel("admission"),
      broadcast: transport.channel("hostcast"),
      update: transport.channel<Uint8Array>("yupdate"),
      sync: transport.channel<Uint8Array>("ysync"),
      presence: transport.channel<Uint8Array>("presence"),
      request: transport.requests("request"),
    };
  }

  private join() {
    if (this.transport) return;
    const relay = this.isHost
      ? this.relaySetup && { ...this.relaySetup, token: this.relaySetup.hostToken }
      : this.link.relay;
    const room = openTransport(this.link, relay, APP_ID, (error, peerId) =>
      this.record({
        level: "error",
        source: peerId ? "peer" : "relay",
        text: error,
        ...(peerId && { peerId }),
      }),
    );
    this.transport = room;
    this.joinedAt = Date.now();
    this.record({ level: "info", source: "relay", text: `joined the room (${room.kind})` });
    this.watchRelays();
    const actions = this.makeActions(room);
    this.actions = actions;

    room.onPeerJoin = (peerId) => {
      this.record({ level: "info", source: "peer", text: "peer connected", peerId });
      // The host's presence goes to a guest once it is in (`letIn`).
      if (this.isHost) void this.greet(peerId);
      else if (this.memberList.has(peerId)) this.sendPresence(peerId);
    };
    room.onPeerLeave = (peerId) => {
      this.record({ level: "info", source: "peer", text: "peer left", peerId });
      this.dropPresence(peerId);
      if (this.isHost) {
        this.identities.forget(peerId);
        this.admissions.leave(peerId);
        this.publishMembers();
        this.refreshKnocks();
      }
      if (peerId === this.hostPeer && !this.isHost) {
        this.record({ level: "warn", source: "host", text: "host left", peerId });
        this.hostOnline = false;
        this.emit("room");
      }
    };

    // Only from members. The host takes none from the lobby: a guest sends
    // its own again once in. Guests take it from peers on the host's list,
    // and hold the last of anyone else's in case the list comes after it.
    actions.presence.onMessage = (update, { peerId }) => {
      const bytes = new Uint8Array(update);
      if (this.isHost ? this.admissions.access(peerId) : this.takesPresence(peerId))
        applyAwarenessUpdate(this.awareness, bytes, peerId);
      else if (!this.isHost) this.heldPresence.set(peerId, bytes);
    };

    // The host's hello proves it is the host and asks who we are; the board
    // comes once it lets us in (`admission`).
    actions.hello.onMessage = async (message, { peerId }) => {
      const { signature, nonce } = message as unknown as Hello;
      if (this.isHost) return;
      if (!(await verifyHost(this.link.hostPublicKey, this.link.roomId, peerId, signature))) {
        this.record({
          level: "error",
          source: "host",
          text: "a peer claimed to be the host, but its signature doesn't match this link's host key",
          peerId,
        });
        return;
      }
      this.record({ level: "info", source: "host", text: "host verified", peerId });
      this.hostPeer = peerId;
      this.hostOnline = true;
      this.emit("room");
      const proof = await provePeer(
        this.key,
        this.link.roomId,
        selfId,
        nonce,
        (await this.sealKey).publicKey,
      );
      // We moved meanwhile: the new room's host asks again.
      if (this.transport !== room) return;
      const { name, color } = this.identity;
      void actions.identify.send(json({ ...proof, name, color } satisfies Identify), {
        target: peerId,
      });
    };

    // A guest's answer to the nonce in our hello: who it is, and so whether it is in.
    actions.identify.onMessage = async (message, { peerId }) => {
      if (!this.isHost || this.admissions.isDropped(peerId)) return;
      const proof = message as unknown as Identify;
      const identities = this.identities;
      const identity = await identities.prove(peerId, proof);
      if (identities !== this.identities) return;
      if (!identity) {
        this.record({
          level: "error",
          source: "peer",
          text: "a peer's proof of its browser key doesn't verify",
          peerId,
        });
        return;
      }
      const who: Identity = {
        name: typeof proof.name === "string" ? proof.name.slice(0, 60) : "guest",
        color: typeof proof.color === "string" ? proof.color.slice(0, 20) : "#888888",
      };
      this.run(this.admissions.arrive(peerId, identity, who));
    };

    actions.admission.onMessage = (message, { peerId }) => {
      if (!this.isHost && this.fromHost(peerId)) this.onAdmission(message as unknown as Admission);
    };

    actions.broadcast.onMessage = (message, { peerId }) => {
      if (this.fromHost(peerId)) this.applyBroadcast(message as unknown as HostBroadcast);
    };

    // A state vector asks for everything the sender is missing.
    actions.sync.onMessage = (vector, { peerId }) => {
      if (this.isHost ? !this.admissions.access(peerId) : !this.fromHost(peerId)) return;
      void actions.update.send(Y.encodeStateAsUpdate(this.doc, new Uint8Array(vector)), {
        target: peerId,
      });
      if (this.isHost) void this.sendSnapshot(peerId);
    };

    actions.update.onMessage = (update, { peerId }) => {
      if (this.isHost) {
        if (!mayEdit(this.admissions.access(peerId))) return;
        Y.applyUpdate(this.doc, new Uint8Array(update), { peer: peerId });
      } else if (this.fromHost(peerId)) {
        Y.applyUpdate(this.doc, new Uint8Array(update), "host");
      }
    };

    actions.request.onRequest = async (request, { peerId }) => {
      const message = request as unknown as GuestRequest | GuestRead;
      return json(
        message.t === "session-open"
          ? this.onGuestRead(peerId, message)
          : await this.onGuestRequest(peerId, message),
      );
    };
  }

  // -------------------------------------------------------------------------
  // connection details (`connection.ts`)

  private record(event: Omit<ConnectionEvent, "at">) {
    this.log = [...this.log.slice(1 - LOG_LIMIT), { at: Date.now(), ...event }];
    this.emit("connection");
  }

  /** How peers reach each other here (ADR 0008), once joined. */
  transportKind() {
    return this.transport?.kind ?? null;
  }

  /** The relays the transport uses — signalling, or the one carrying everything — and their state. */
  relays(): RelayInfo[] {
    return [...(this.transport?.diagnostics().relays ?? [])];
  }

  /** The peers we can reach now. */
  peerIds(): string[] {
    return this.transport?.peers() ?? [];
  }

  /** The connected peers' WebRTC connections, by peer id; none over the relay transport. */
  peerConnections(): Readonly<Record<string, RTCPeerConnection>> {
    return this.transport?.diagnostics().connections ?? {};
  }

  /** Transports reconnect relays by themselves and say nothing: log what changes. */
  private watchRelays() {
    if (this.relayWatch) return;
    this.relayWatch = setInterval(() => {
      if (!this.transport) return;
      for (const { url, state } of this.relays()) {
        const was = this.relayStates.get(url);
        if (was === state || state === "closing") continue;
        this.relayStates.set(url, state);
        if (state === "connecting" && was === undefined) continue;
        this.record({
          level: state === "open" ? "info" : "warn",
          source: "relay",
          text: `${url} ${state === "open" ? "open" : state === "closed" ? "closed" : "reconnecting"}`,
        });
      }
    }, 1000);
  }

  private fromHost(peerId: string) {
    return this.hostOnline && this.hostPeer === peerId;
  }

  private sendPresence(peerId: string | ReadonlyArray<string>) {
    if (peerId.length === 0) return;
    void this.actions?.presence.send(encodeAwarenessUpdate(this.awareness, [this.doc.clientID]), {
      target: peerId,
    });
  }

  /** Guests: whom our presence goes to — once in, the host and the others on its list. */
  private presenceTargets(): string[] {
    if (this.admission !== "admitted") return [];
    const targets = new Set(this.memberList.peers());
    if (this.hostPeer && this.hostOnline) targets.add(this.hostPeer);
    return [...targets];
  }

  /** Guests: whose presence we take — once in, the host's, and those on its list. */
  private takesPresence(peerId: string) {
    if (this.admission !== "admitted") return false;
    return this.fromHost(peerId) || this.memberList.has(peerId);
  }

  /** A peer's presence goes (it left, or is off the list). */
  private dropPresence(peerId: string) {
    removeAwarenessStates(this.awareness, [...(this.peerClients.get(peerId) ?? [])], "leave");
    this.peerClients.delete(peerId);
    this.heldPresence.delete(peerId);
  }

  /** Host: prove who we are to a new peer, and ask it who it is. */
  private async greet(peerId: string) {
    const actions = this.actions;
    if (!actions || !this.hostPrivateKey) return;
    if (!this.roomState || this.admissions.isDropped(peerId)) return;
    const nonce = this.identities.challenge(peerId);
    const signature = await signHost(this.hostPrivateKey, this.link.roomId, selfId);
    if (this.actions !== actions) return;
    await actions.hello.send(json({ signature, nonce } satisfies Hello), { target: peerId });
  }

  /**
   * Host: sign who is in — their peer ids and the fingerprints we verified,
   * ours included — and tell them (`member-list.ts`).
   */
  private publishMembers() {
    const members = this.verifiedFingerprints();
    // A knock or a role changes nobody's place on it.
    if (JSON.stringify(members) === JSON.stringify(this.fingerprints)) return;
    this.setFingerprints(members);
    const key = this.hostPrivateKey;
    if (!key) return;
    this.listVersion = nextVersion(this.listVersion);
    const list = { host: selfId, version: this.listVersion, members: this.fingerprints };
    void signMembers(key, this.link.roomId, list).then((signed) => {
      // Signing takes a moment: a later list may have gone out meanwhile.
      if (list.version !== this.listVersion || !this.actions) return;
      this.signedList = signed;
      this.hostcast({ t: "member-list", ...signed });
    });
  }

  private verifiedFingerprints() {
    return { ...this.admissions.fingerprints(), [selfId]: this.fingerprint };
  }

  // -------------------------------------------------------------------------
  // admission (`admission.ts`)

  /** Host: do what a change in who is in asks for. */
  private run(steps: ReadonlyArray<Step>) {
    for (const step of steps) {
      switch (step.t) {
        case "admit":
          this.letIn(step.peerId, step.access);
          break;
        case "access":
          this.tell(step.peerId, {
            t: "access",
            access: step.access,
            ...(mayEdit(step.access) &&
              !mayEdit(step.was) && { vector: [...Y.encodeStateVector(this.doc)] }),
          });
          // `view` guests never got the trees; now they may browse them.
          if (step.was === "view")
            for (const { at, paths } of this.trees.values())
              void this.actions?.broadcast.send(json({ t: "tree", ...at, paths }), {
                target: step.peerId,
              });
          break;
        case "knock":
          this.record({
            level: "info",
            source: "peer",
            text: `${step.knock.name} knocks`,
            peerId: step.knock.peerId,
          });
          this.tell(step.knock.peerId, { t: "lobby" });
          break;
        case "cut":
          this.tell(step.peerId, { t: "removed" });
          this.shutOut(step.peerId);
          break;
      }
    }
    if (steps.length) {
      this.publishMembers();
      this.refreshKnocks();
    }
  }

  private tell(peerId: string, message: Admission) {
    void this.actions?.admission.send(json(message), { target: peerId });
  }

  /** Host: a peer is in. It syncs against our vector (`onAdmission`); then it gets the rest. */
  private letIn(peerId: string, access: GuestAccess) {
    if (!this.roomState) return;
    this.tell(peerId, {
      t: "admitted",
      access,
      state: this.roomState,
      vector: [...Y.encodeStateVector(this.doc)],
    });
    this.sendPresence(peerId);
  }

  /** Host: a peer is out: its presence goes, and so do its requests waiting for us. */
  private shutOut(peerId: string) {
    this.dropPresence(peerId);
    for (const approval of this.approvals.filter((a) => a.peerId === peerId))
      approval.resolve(false);
  }

  private refreshKnocks() {
    this.knocks = this.admissions.knocks();
    this.emit("members");
  }

  /** Guests: what the host says about letting us in. */
  private onAdmission(message: Admission) {
    switch (message.t) {
      case "lobby":
        this.admission = "lobby";
        break;
      case "admitted": {
        this.admission = "admitted";
        this.access = message.access;
        this.roomState = message.state;
        const host = message.state.hostPeerId;
        void this.actions?.update.send(
          Y.encodeStateAsUpdate(this.doc, Uint8Array.from(message.vector)),
          { target: host },
        );
        void this.actions?.sync.send(Y.encodeStateVector(this.doc), { target: host });
        // Nobody had our presence while we waited: the host now, the others
        // as they are on its list (`onMemberList`).
        this.sendPresence(this.presenceTargets());
        break;
      }
      case "access":
        this.access = message.access;
        if (message.vector && this.hostPeer)
          void this.actions?.update.send(
            Y.encodeStateAsUpdate(this.doc, Uint8Array.from(message.vector)),
            { target: this.hostPeer },
          );
        break;
      case "denied":
      case "removed":
        return this.leaveRoom(message.t);
      case "moved":
        return void this.onMoved(message);
    }
    this.emit("room");
  }

  /** Guests: the host shut us out. Leave the room, and forget what it showed us. */
  private leaveRoom(why: "denied" | "removed") {
    this.record({
      level: "warn",
      source: "host",
      text: why === "denied" ? "the host didn't let us in" : "the host removed us",
    });
    this.admission = why;
    this.access = null;
    this.roomState = null;
    this.hostOnline = false;
    this.leaveTransport();
    this.sessions.clear();
    this.sessionsKnown = false;
    this.shownHere = null;
    this.asked.clear();
    this.kinds.clear();
    this.terminals.clear();
    this.files.clear();
    this.trees.clear();
    this.memberList.reset();
    this.heldPresence.clear();
    this.setFingerprints({});
    this.emit("sessions");
    this.emit("tree");
    this.emit("room");
  }

  /** Host: let a knocking peer in, as a member with `role`; `canvas serve` saves it. */
  admit(peerId: string, role: MemberRole) {
    const knock = this.admissions.knock(peerId);
    if (!knock || this.server?.status !== "open") return;
    this.server.send({ t: "member-admit", publicKey: knock.publicKey, name: knock.name, role });
  }

  /** Host: turn a knocking peer away. */
  deny(peerId: string) {
    if (!this.admissions.deny(peerId)) return;
    this.tell(peerId, { t: "denied" });
    this.refreshKnocks();
  }

  /** Host: what a member may do from now on. */
  setRole(fingerprint: string, role: MemberRole) {
    this.server?.send({ t: "member-role", fingerprint, role });
  }

  /**
   * Host: trust a member, or take it back: runs without the approval click,
   * typing into terminals. Never saved; it lasts while this tab is the host.
   */
  trust(fingerprint: string, on: boolean) {
    this.run(this.admissions.trust(fingerprint, on));
    this.refreshTrusted();
  }

  private refreshTrusted() {
    this.trusted = this.members.flatMap((m) =>
      this.admissions.isTrusted(m.fingerprint) ? [m.fingerprint] : [],
    );
    this.emit("members");
  }

  /**
   * Host: a member is out, at once; coming again is knocking again. `canvas
   * serve` resets the invite link too: the link they hold leads nowhere.
   */
  removeMember(fingerprint: string) {
    this.server?.send({ t: "member-remove", fingerprint });
  }

  /** Host: a new invite link (decision 6). Members here move along; links from before lead nowhere. */
  resetInviteLink() {
    this.server?.send({ t: "room-reset" });
  }

  /**
   * Host: `canvas serve` minted a new room. Each member that is in gets it,
   * sealed to its own seal key; once they left for it, or a moment passed,
   * we follow. Nobody else is told.
   */
  private async move(secrets: RoomSecrets, relay: WelcomeRelay | null) {
    const from = this.link;
    const next: BoardLink = { ...from, roomId: secrets.roomId, key: secrets.key };
    this.next = next;
    this.relaySetup = relay;
    this.emit("room");
    const { actions, transport, hostPrivateKey } = this;
    if (actions && transport && hostPrivateKey) {
      const move: Move = { roomId: next.roomId, key: next.key, relay: this.guestRelay() };
      const moving = this.admissions.moving();
      this.record({
        level: "info",
        source: "relay",
        text: `the invite link was reset: ${moving.length} member${moving.length === 1 ? "" : "s"} move along`,
      });
      await Promise.allSettled(
        moving.map(async ({ peerId, sealKey }) => {
          const sealed = await sealMove(hostPrivateKey, from.roomId, peerId, sealKey, move);
          await actions.admission.send(json({ t: "moved", ...sealed } satisfies Admission), {
            target: peerId,
          });
        }),
      );
      // Leaving closes the channels: what we sent must arrive first.
      const end = Date.now() + MOVE_WAIT_MS;
      while (Date.now() < end && moving.some(({ peerId }) => transport.peers().includes(peerId)))
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.relocate(next);
  }

  /**
   * Guests: the host handed us the new room. If it opens with our seal key
   * and the host signed it for us, we go there; the host follows.
   */
  private async onMoved(sealed: SealedMove) {
    const { link, hostPeer, transport } = this;
    const move = await openMove(
      await this.sealKey,
      link.hostPublicKey,
      link.roomId,
      selfId,
      sealed,
    );
    if (this.transport !== transport || this.hostPeer !== hostPeer || !transport) return;
    if (!move)
      return this.record({
        level: "error",
        source: "host",
        text: "a handover to a new room didn't open with our key, or the host didn't sign it",
      });
    this.record({ level: "info", source: "host", text: "the invite link was reset: moving along" });
    this.relocate({ ...link, roomId: move.roomId, key: move.key, relay: move.relay });
  }

  /**
   * Into the room `next` names. The old room's peers are gone; who is in
   * comes again there, and the address bar shows it, so a reload comes back.
   * A guest stays in meanwhile: its board stays up, waiting for the host.
   */
  private relocate(next: BoardLink) {
    const joined = this.transport !== null;
    this.leaveTransport();
    this.current = next;
    this.next = null;
    showLink(next);
    this.identities = new PeerIdentities(next.roomId);
    this.memberList = new Members(next.roomId, next.hostPublicKey, selfId);
    this.heldPresence.clear();
    this.setFingerprints({});
    if (this.isHost) {
      this.admissions.moved();
      this.signedList = null;
      for (const approval of [...this.approvals]) approval.resolve(false);
      this.refreshKnocks();
    } else {
      this.hostPeer = null;
      this.hostOnline = false;
    }
    this.emit("room");
    if (joined) this.join();
  }

  /** Out of the room's transport: nobody's presence stays. */
  private leaveTransport() {
    this.transport?.leave();
    this.transport = null;
    this.actions = null;
    this.joinedAt = null;
    const clients = [...this.peerClients.values()].flatMap((ids) => [...ids]);
    removeAwarenessStates(this.awareness, clients, "leave");
    this.peerClients.clear();
  }

  private setFingerprints(fingerprints: Readonly<Record<string, string>>) {
    this.fingerprints = fingerprints;
    this.refreshPeers();
  }

  /** The fingerprint `peerId` verified with; null if it hasn't (yet). */
  fingerprintOf(peerId: string): string | null {
    return this.fingerprints[peerId] ?? null;
  }

  /** Host: the key `peerId` proved it holds, if it has. */
  verifiedPeer(peerId: string): PeerIdentity | undefined {
    return this.identities.get(peerId);
  }

  /**
   * Host: bring a guest up to date. Every session's head goes first (ADR
   * 0012), then the history of each one a frame shows, shortest first — those
   * whose log we have; the others follow as we get them — then what each kind
   * of agent offers, terminals, files and the tree, one message at a time, as
   * messages sent together share the channel and all arrive late.
   */
  private async sendSnapshot(peerId: string) {
    const actions = this.actions;
    const access = this.admissions.access(peerId);
    if (!actions || !access) return;
    // The sessions frames show here are the board's own runtime's: keyed by their bare ids.
    const shown = shownSessions(this.here());
    const sessions = [...this.sessions.values()];
    // Every session's head, a message per runtime; the own one's always.
    const heads = new Map<string | undefined, SessionHead[]>([[undefined, []]]);
    for (const { at, meta, options } of sessions) {
      let list = heads.get(at.runtime);
      if (!list) heads.set(at.runtime, (list = []));
      list.push({ meta, ...(options && { options }) });
    }
    // All taken now: what changes from here on reaches the guest live.
    const messages: HostBroadcast[] = [
      ...[...heads].map(([runtime, list]) => ({
        t: "sessions" as const,
        ...(runtime !== undefined && { runtime }),
        sessions: list,
      })),
      ...sessions
        .filter((s) => !s.at.runtime && shown.has(s.meta.id) && s.pending === null)
        .map((s) => ({ sessionId: s.meta.id, events: s.events.slice() }))
        .sort((a, b) => a.events.length - b.events.length)
        .map(({ sessionId, events }) => ({ t: "session-history" as const, sessionId, events })),
      ...[...this.kinds.values()].map(({ at, id: agent, options }) => ({
        t: "kind-options" as const,
        ...at,
        agent,
        options,
      })),
      ...[...this.terminals.values()].map(({ at, id: pty, data }) => ({
        t: "term-data" as const,
        ...at,
        pty,
        data,
      })),
      ...[...this.files.values()].map(({ at, id: path, file }) => ({
        t: "file" as const,
        ...at,
        path,
        file,
      })),
      ...(access !== "view"
        ? [...this.trees.values()].map(({ at, paths }) => ({ t: "tree" as const, ...at, paths }))
        : []),
      ...(this.signedList ? [{ t: "member-list" as const, ...this.signedList }] : []),
    ];
    try {
      for (const message of messages) {
        // It may be cut off meanwhile.
        if (!this.admissions.access(peerId)) return;
        await actions.broadcast.send(json(message), { target: peerId });
      }
    } catch {
      // The guest left; it gets a new snapshot when it is back.
    }
  }

  /** Host: to every peer that is in (whose access `to` takes, if given), and nobody else. */
  private hostcast(message: HostBroadcast, to: (access: GuestAccess) => boolean = () => true) {
    const targets = this.admissions.admitted().filter((id) => to(this.admissions.access(id)!));
    if (targets.length) void this.actions?.broadcast.send(json(message), { target: targets });
  }

  private onDocUpdate(update: Uint8Array, origin: unknown) {
    if (this.isHost) {
      // Fan out to everyone but the guest it came from.
      const from =
        typeof origin === "object" && origin !== null && "peer" in origin
          ? (origin.peer as string)
          : null;
      const targets = this.admissions.admitted().filter((id) => id !== from);
      if (targets.length) void this.actions?.update.send(update, { target: targets });
      if (origin !== "server") this.scheduleSave();
      this.scheduleTidy();
      this.syncResources();
    } else {
      if (origin !== "host" && this.hostOnline && this.hostPeer && this.access)
        void this.actions?.update.send(update, { target: this.hostPeer });
      this.openShown();
    }
  }

  private applyBroadcast(message: HostBroadcast) {
    switch (message.t) {
      case "sessions": {
        // Every head of one runtime: those we had of it go.
        const runtime = this.keyOf({ runtime: message.runtime }, "");
        for (const [key, session] of this.sessions)
          if (this.keyOf(session.at, "") === runtime) this.sessions.delete(key);
        for (const head of message.sessions) this.putSession(message, head, null);
        if (reach(message, this.runtime) === "own") {
          this.asked.clear();
          this.sessionsKnown = true;
          // The logs of the sessions frames show now come after this; others as frames show them.
          this.shownHere = shownSessions(this.here());
        }
        this.emit("sessions");
        this.emit("room");
        return;
      }
      case "session-history":
        if (reach(message, this.runtime) === "own") this.asked.delete(message.sessionId);
        return this.putHistory(message, message.sessionId, message.events);
      case "kind-options":
        return this.putKind(message, message.agent, message.options);
      case "agent-meta":
        return this.putMeta(message, message.meta);
      case "agent-event":
        return void this.pushEvent(message, message.sessionId, message.event, message.index);
      case "agent-options":
        return this.putOptions(message, message.sessionId, message.options);
      case "term-data":
        return this.pushTerm(message, message.pty, message.data);
      case "file":
        return this.putFile(message, message.path, message.file);
      case "tree":
        return this.putTree(message, message.paths);
      case "member-list":
        return void this.onMemberList(message);
    }
  }

  /**
   * Guests: a member list from the host. Taken if signed and newer: presence
   * of those off it goes, those new on it get ours (and their held one is in).
   */
  private async onMemberList(signed: SignedMemberList) {
    const host = this.hostPeer;
    if (!host) return;
    const change = await this.memberList.accept(signed, host);
    if (!change || this.hostPeer !== host || !this.actions) return;
    for (const peerId of change.removed) this.dropPresence(peerId);
    this.setFingerprints(this.memberList.fingerprints());
    if (this.admission !== "admitted") return;
    const added = change.added.filter((id) => id !== host);
    if (added.length) this.sendPresence(added);
    for (const peerId of added) {
      const held = this.heldPresence.get(peerId);
      this.heldPresence.delete(peerId);
      if (held) applyAwarenessUpdate(this.awareness, held, peerId);
    }
  }

  // -------------------------------------------------------------------------
  // sessions & terminals (local mirror)

  /** A session with its log, or (null) one whose history is still on its way. */
  private putSession(
    at: UncheckedAddress,
    head: SessionHead,
    events: ReadonlyArray<AgentEvent> | null,
  ) {
    const key = this.keyOf(at, head.meta.id);
    this.sessions.set(key, {
      at: this.runtimeOf(at),
      meta: head.meta,
      events: events ? [...events] : [],
      pending: events ? null : [],
      options: head.options,
      version: Date.now(),
    });
    this.emit(`session:${key}`);
    this.emit("sessions");
  }

  /**
   * A session's history arrived. Host: `canvas serve` sent it after
   * everything before, so it is all. Guests: it replaces the log we have, up
   * to its length, and what came live continues it by place (`mergeLog`) —
   * whatever came first, also a history sent again after the host's link to
   * `canvas serve` came back.
   */
  private putHistory(at: UncheckedAddress, sessionId: string, events: ReadonlyArray<AgentEvent>) {
    const key = this.keyOf(at, sessionId);
    const session = this.sessions.get(key);
    if (!session) return;
    if (this.isHost) {
      if (!session.pending) return;
      session.events = [...events];
    } else {
      const live = session.pending ?? session.events.map((event, index) => ({ index, event }));
      session.events = mergeLog(events, live);
    }
    session.pending = null;
    session.version++;
    this.emit(`session:${key}`);
  }

  private putKind(at: UncheckedAddress, agent: AgentKind, options: AgentOptions) {
    this.kinds.set(this.keyOf(at, agent), { at: this.runtimeOf(at), id: agent, options });
    this.emit("sessions");
  }

  private putMeta(at: UncheckedAddress, meta: SessionMeta) {
    const key = this.keyOf(at, meta.id);
    const session = this.sessions.get(key);
    if (session) {
      session.meta = meta;
      session.version++;
    } else
      this.sessions.set(key, {
        at: this.runtimeOf(at),
        meta,
        events: [],
        pending: null,
        options: undefined,
        version: 0,
      });
    this.emit(`session:${key}`);
    this.emit("sessions");
  }

  private putOptions(at: UncheckedAddress, sessionId: string, options: AgentOptions) {
    const key = this.keyOf(at, sessionId);
    const session = this.sessions.get(key);
    if (!session) return;
    session.options = options;
    session.version++;
    this.emit(`session:${key}`);
  }

  /**
   * An event, live; false if it was held or dropped instead. The host's come
   * from `canvas serve` in order; a guest's carry their place in the log
   * (`index`), and one after a gap asks for the log again.
   */
  private pushEvent(
    at: UncheckedAddress,
    sessionId: string,
    event: AgentEvent,
    index?: number,
  ): boolean {
    const key = this.keyOf(at, sessionId);
    const session = this.sessions.get(key);
    if (!session) return false;
    if (session.pending) {
      // Host: its log, when it comes, has this already.
      if (!this.isHost) session.pending.push({ index: index ?? Infinity, event });
      return false;
    }
    switch (index === undefined ? "append" : place(session.events.length, index)) {
      case "have":
        return false;
      case "gap":
        session.pending = [{ index: index!, event }];
        if (reach(at, this.runtime) === "own") this.askLog(sessionId);
        return false;
    }
    session.events.push(event);
    session.version++;
    this.emit(`session:${key}`);
    return true;
  }

  private pushTerm(at: UncheckedAddress, pty: string, data: string) {
    const key = this.keyOf(at, pty);
    const all = (this.terminal(pty, at) + data).slice(-TERM_SCROLLBACK);
    this.terminals.set(key, { at: this.runtimeOf(at), id: pty, data: all });
    this.emit(`term:${key}`);
  }

  private putFile(at: UncheckedAddress, path: string, file: FileContent) {
    const key = this.keyOf(at, path);
    this.files.set(key, { at: canonical(at, this.runtime), id: path, file });
    this.emit(`file:${key}`);
  }

  private putTree(at: UncheckedAddress, paths: ReadonlyArray<string>) {
    this.trees.set(this.keyOf(at, ""), { at: canonical(at, this.runtime), id: "", paths });
    this.emit("tree");
  }

  /** The runtime of an address, as writers write it: sessions, kinds and PTYs have no root. */
  private runtimeOf(at: UncheckedAddress): Address {
    const { runtime } = canonical(at, this.runtime);
    return runtime === undefined ? {} : { runtime };
  }

  // -------------------------------------------------------------------------
  // host ⇄ server

  private onServer(message: ServerToClient) {
    switch (message.t) {
      case "welcome": {
        this.hostPrivateKey = message.room.hostPrivateKey;
        this.relaySetup = message.relay ?? null;
        // The invite link was reset since this link was made: the room is `canvas serve`'s.
        const { roomId, key } = message.room;
        if (roomId !== this.link.roomId || key !== this.link.key)
          this.relocate({ ...this.link, roomId, key });
        if (message.board)
          Y.applyUpdate(
            this.doc,
            Uint8Array.from(atob(message.board), (c) => c.charCodeAt(0)),
            "server",
          );
        // Boards from before the tree are migrated before anyone joins.
        tidy(this.doc, { screen: boardHeight() });
        // Heads only: the logs of the sessions frames show are asked for (`syncResources`).
        // All of them this runtime's, `canvas serve`'s: the board's own.
        this.sessions.clear();
        this.sessionsKnown = true;
        for (const head of message.sessions) this.putSession({}, head, null);
        this.kinds.clear();
        for (const [agent, options] of Object.entries(message.kindOptions))
          this.putKind({}, agent, options);
        this.emit("sessions");
        this.roomState = {
          hostPeerId: selfId,
          runtime: message.runtime,
          cwd: message.cwd,
          agents: message.agents,
          version: message.version,
        };
        this.hostOnline = true;
        this.emit("room");
        this.setMembers(message.members);
        this.join();
        this.syncResources();
        for (const peerId of this.admissions.admitted()) void this.sendSnapshot(peerId);
        return;
      }
      case "members":
        return this.setMembers(message.members);
      case "room": {
        const { room, relay } = message;
        this.moving = this.moving
          .then(() => this.move(room, relay))
          .catch((error: unknown) =>
            this.record({
              level: "error",
              source: "serve",
              text: `resetting the invite link: ${error}`,
            }),
          );
        return;
      }
      // What `canvas serve` sends names what it is about as it was asked
      // (ADR 0013, decision 7), and goes on to guests so.
      case "agent-meta":
        this.putMeta(message, message.meta);
        if (reach(message, this.runtime) === "own") {
          // Its turn is over: it leaves the frame it worked on.
          if (message.meta.status === "idle") this.releaseAgent(message.meta.id);
          // No frame shows it since it ran: its agent stops now.
          if (this.releases.settle(message.meta.id, message.meta.status))
            this.server?.send({ t: "agent-release", sessionId: message.meta.id });
        }
        return this.hostcast(message);
      case "agent-event": {
        // Guests get a session's events once we have its log, after it.
        const { sessionId, event } = message;
        if (this.pushEvent(message, sessionId, event)) {
          const index = this.session(sessionId, message)!.events.length - 1;
          const at = this.runtimeOf(message);
          this.hostcast({ t: "agent-event", ...at, sessionId, event, index });
        }
        return;
      }
      case "agent-options":
        this.putOptions(message, message.sessionId, message.options);
        return this.hostcast(message);
      case "session-history":
        this.putHistory(message, message.sessionId, message.events);
        return this.hostcast(message);
      case "kind-options":
        this.putKind(message, message.agent, message.options);
        return this.hostcast(message);
      case "term-data":
        this.pushTerm(message, message.pty, message.data);
        return this.hostcast(message);
      case "term-exit": {
        const data = `\r\n\x1b[2m[process exited${message.code === null ? "" : ` with ${message.code}`}]\x1b[0m\r\n`;
        const { pty } = message;
        this.pushTerm(message, pty, data);
        this.opened.delete(this.keyOf(message, pty));
        return this.hostcast({ t: "term-data", ...this.runtimeOf(message), pty, data });
      }
      case "file":
        this.putFile(message, message.path, message.file);
        return this.hostcast(message);
      case "tree":
        this.putTree(message, message.paths);
        return this.hostcast(message, (access) => access !== "view");
      case "board-call":
        return void this.runBoardCall(message);
      case "error":
        return this.record({ level: "error", source: "serve", text: message.message });
    }
  }

  /**
   * Host: keep the board's tree tidy (`tidy`) a moment after it changes —
   * only the tab `canvas serve` talks to, so two tabs never both do.
   */
  private scheduleTidy() {
    if (this.tidyTimer) clearTimeout(this.tidyTimer);
    this.tidyTimer = setTimeout(() => {
      if (this.serverStatus === "open") tidy(this.doc, { screen: boardHeight() });
    }, 200);
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const state = Y.encodeStateAsUpdate(this.doc);
      let binary = "";
      for (const byte of state) binary += String.fromCharCode(byte);
      this.server?.send({ t: "board-save", state: btoa(binary) });
    }, 800);
  }

  private frames(): Frame[] {
    return allFrames(this.doc);
  }

  /**
   * The board's own runtime's id (ADR 0013, decision 3): what an absent
   * `runtime` means; null until the welcome, or the host, says.
   */
  get runtime(): string | null {
    return this.roomState?.runtime ?? null;
  }

  /** Where a frame's agent, file or terminal is, from here (`frameReach`). */
  reachOf(frame: Frame) {
    return frameReach(frame, this.runtime);
  }

  /**
   * A frame's address as writers write it (ADR 0013): what its messages and
   * links name; none on the board's own runtime and working dir.
   */
  addressOf(frame: Frame): Address {
    switch (frame.type) {
      case "file":
        return canonical(frame, this.runtime);
      case "agent":
      case "terminal":
        return this.runtimeOf(frame);
      default:
        return {};
    }
  }

  /**
   * The frames whose agent, file or terminal is on a runtime we reach: the
   * board's own (ADR 0013, decision 7). Nothing is opened, sent or asked
   * for the others; they show as not reachable.
   */
  private here(): Frame[] {
    return this.frames().filter((frame) => this.reachOf(frame) === "own");
  }

  /**
   * Host: run an agent's board tool call against the board, and answer it.
   * A drawing's elements are made before, and its image after (ADR 0009).
   */
  private async runBoardCall(message: Extract<ServerToClient, { t: "board-call" }>) {
    let ok = true;
    let text: string;
    let images: ToolImage[] | undefined;
    try {
      const args = await prepareDrawCall(this.doc, message.tool, message.args);
      const result = runBoardTool(
        {
          doc: this.doc,
          // The frame the agent acts as: its turn's (ADR 0012, decision 3).
          self: message.frameId,
          runtime: this.runtime,
          agents: this.roomState?.agents ?? [],
          status: (frameId) => this.statusOf(frameId),
        },
        message.tool,
        args,
      );
      text = result.text;
      if (result.image) images = [await drawingImage(this.doc, result.image)];
      if (result.frame) this.claimForAgent(message.sessionId, message.frameId, result.frame);
    } catch (error) {
      ok = false;
      text = error instanceof Error ? error.message : String(error);
    }
    this.server?.send({ t: "board-result", callId: message.callId, ok, text, images });
  }

  /** The status of the session an agent frame shows, if it has begun. */
  private statusOf(frameId: string) {
    const frame = this.agentFrame(frameId);
    return frame && this.session(shownSession(frame), frame)?.meta.status;
  }

  private agentFrame(frameId: string): AgentFrame | undefined {
    const frame = this.frames().find((f) => f.id === frameId);
    return frame?.type === "agent" ? frame : undefined;
  }

  /**
   * Host: make sure exactly the files the board shows are open and every
   * terminal is running; get the logs of the sessions agent frames show, and
   * what a kind of agent offers where a frame's session hasn't begun (ADR
   * 0012). A session no frame shows any more is released: its agent stops.
   * Only frames on `canvas serve`'s runtime (ADR 0013): their things are
   * keyed by their bare ids, and named to it without an address.
   */
  private syncResources() {
    if (!this.isHost || this.server?.status !== "open") return;
    const frames = this.here();
    const paths = new Set(
      frames.flatMap((frame) => (frame.type === "file" && frame.path ? [frame.path] : [])),
    );
    for (const path of paths) {
      if (this.watched.has(path)) continue;
      this.watched.add(path);
      this.server.send({ t: "file-open", path });
    }
    for (const path of this.watched) {
      if (paths.has(path)) continue;
      this.watched.delete(path);
      this.server.send({ t: "file-close", path });
    }
    // File frames browse the tree; links in agents' replies are checked against it (ADR 0007).
    if (
      frames.some((frame) => frame.type === "file" || frame.type === "agent") &&
      !this.treeWatched
    ) {
      this.treeWatched = true;
      this.server.send({ t: "tree-watch" });
    }
    for (const frame of frames) {
      if (frame.type === "agent" && frame.agent) {
        const sessionId = shownSession(frame);
        const session = this.sessions.get(sessionId);
        if (session?.pending && !this.opened.has(`log:${sessionId}`)) {
          this.opened.add(`log:${sessionId}`);
          this.server.send({ t: "session-open", sessionId });
        }
        // Settings to show before its agent runs: what the kind offers.
        const unknown = !session?.options && !this.kinds.has(frame.agent);
        if (unknown && !this.opened.has(`kind:${frame.agent}`)) {
          this.opened.add(`kind:${frame.agent}`);
          this.server.send({ t: "kind-probe", agent: frame.agent });
        }
      }
      const pty = frame.type === "terminal" ? shownPty(frame) : null;
      if (pty && !this.opened.has(pty)) {
        this.opened.add(pty);
        this.terminals.delete(pty);
        this.server.send({ t: "term-open", pty, cols: 80, rows: 24 });
      }
    }
    const shown = shownSessions(frames);
    const status = (id: string) => this.sessions.get(id)?.meta.status;
    for (const sessionId of this.releases.show(shown, status))
      this.server.send({ t: "agent-release", sessionId });
  }

  /**
   * Guests: ask the host for the logs of sessions frames came to show since
   * the heads came (those the frames showed then come by themselves).
   */
  private openShown() {
    if (this.isHost || !this.shownHere) return;
    const shown = shownSessions(this.here());
    for (const sessionId of shown)
      if (!this.shownHere.has(sessionId) && this.sessions.get(sessionId)?.pending)
        this.askLog(sessionId);
    this.shownHere = shown;
  }

  /** Guests: a session's log, from the host (`GuestRead`): it comes as a `session-history`. */
  private askLog(sessionId: string) {
    const host = this.hostPeer;
    if (this.isHost || !host || !this.actions || this.asked.has(sessionId)) return;
    this.asked.add(sessionId);
    const read: GuestRead = { t: "session-open", sessionId };
    void this.actions.request
      .request(json(read), { target: host, timeoutMs: 60_000 })
      .then((reply) => {
        if (!(reply as unknown as GuestReply).ok) this.asked.delete(sessionId);
      })
      .catch(() => this.asked.delete(sessionId));
  }

  // -------------------------------------------------------------------------
  // actions — the same API for host and guests

  /** Run something on the host's machine: directly as host, as a request as guest. */
  async act(request: GuestRequest): Promise<void> {
    if (this.isHost) return this.execute(request, this.identity);
    const hostPeerId = this.hostPeer;
    if (!this.actions || !hostPeerId || !this.hostOnline) throw new Error("the host is offline");
    const reply = (await this.actions.request.request(json(request), {
      target: hostPeerId,
      timeoutMs: 5 * 60_000,
    })) as unknown as GuestReply;
    if (!reply.ok) throw new Error(reply.error);
  }

  /**
   * Host: run a request on `canvas serve`. Only for its runtime, the board's
   * own (ADR 0013, decision 7): another's isn't reachable from here.
   */
  private execute(request: GuestRequest, author: Identity) {
    if (reach(request, this.runtime) !== "own") throw new Error(NOT_REACHABLE);
    if (!this.server || this.server.status !== "open")
      throw new Error("not connected to canvas serve");
    switch (request.t) {
      case "agent-prompt": {
        const { sessionId, frameId, text } = request;
        const frame = promptFrame(this.frames(), frameId, sessionId);
        if (this.reachOf(frame) !== "own") throw new Error(NOT_REACHABLE);
        const session = this.sessions.get(sessionId);
        if (session && session.meta.status !== "idle") throw new Error("the agent is still busy");
        // The first prompt begins the session (ADR 0012, decision 4), as the frame says.
        const start = startIn(frame, !!session);
        this.server.send({ t: "agent-prompt", sessionId, ...start, text, author });
        return;
      }
      case "agent-cancel":
        this.server.send({ t: "agent-cancel", sessionId: request.sessionId });
        return;
      case "agent-config": {
        const { sessionId, configId, value } = request;
        // Not begun yet: the change begins it, as the frame showing it says.
        const frame = framesShowing(this.here(), sessionId)[0];
        const start = frame && !this.sessions.has(sessionId) ? startIn(frame, false) : undefined;
        this.server.send({
          t: "agent-config",
          sessionId,
          configId,
          value,
          ...(start && { start }),
        });
        return;
      }
      case "term-input":
        this.server.send({ t: "term-input", pty: request.pty, data: request.data });
        return;
    }
  }

  private peerIdentity(peerId: string): Identity {
    for (const id of this.peerClients.get(peerId) ?? []) {
      const state = this.awareness.getStates().get(id) as Presence | undefined;
      if (state?.user) return { name: state.user.name, color: state.user.color };
    }
    return { name: `guest ${peerId.slice(0, 4)}`, color: "#888888" };
  }

  private async onGuestRequest(peerId: string, request: GuestRequest): Promise<GuestReply> {
    const peer = this.peerIdentity(peerId);
    try {
      // Not for the host to approve: it can't reach it.
      if (reach(request, this.runtime) !== "own") throw new Error(NOT_REACHABLE);
      const verdict = check(this.admissions.access(peerId), request);
      if (!verdict.ok) throw new Error(verdict.error);
      if (verdict.approve && !(await this.ask(peerId, peer, request)))
        throw new Error(`${this.identity.name} declined`);
      // Its role may have changed while we decided.
      const now = check(this.admissions.access(peerId), request);
      if (!now.ok) throw new Error(now.error);
      this.execute(request, peer);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Host: a guest reads what the board shows anyway — any member that is in,
   * `view` too; nothing for the lobby (ADR 0011). A session's log goes to it
   * now, or with everyone's once `canvas serve` sends it to us.
   */
  private onGuestRead(peerId: string, read: GuestRead): GuestReply {
    if (!this.admissions.access(peerId)) return { ok: false, error: "the host hasn't let you in" };
    const session = this.session(read.sessionId, read);
    if (!session) return { ok: false, error: "no such conversation" };
    if (!session.pending) {
      const history: HostBroadcast = {
        t: "session-history",
        ...session.at,
        sessionId: read.sessionId,
        events: session.events.slice(),
      };
      void this.actions?.broadcast.send(json(history), { target: peerId });
    }
    return { ok: true };
  }

  private ask(peerId: string, peer: Identity, request: GuestRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const approval: Approval = {
        id: crypto.randomUUID(),
        peerId,
        peer,
        request,
        resolve: (approved) => {
          this.approvals = this.approvals.filter((a) => a !== approval);
          this.emit("approvals");
          resolve(approved);
        },
      };
      this.approvals = [...this.approvals, approval];
      this.emit("approvals");
    });
  }

  /** The room guest links name: after a reset, the new one at once, while members move there. */
  inviteRoom(): BoardLink {
    return this.next ?? this.current;
  }

  /** The relay guest links name, with the guest token; null for a board without one. */
  guestRelay(): RelayLink | null {
    if (!this.isHost) return this.link.relay;
    const setup = this.relaySetup;
    return setup && { url: setup.url, via: setup.via, token: setup.guestToken };
  }

  /** Host: be the host again after another tab took over (it steps down in turn). */
  takeOver() {
    this.server?.takeOver();
  }

  /** Host: why `canvas serve` refused this browser, if it did. */
  get serverRefusal(): string | null {
    return this.server?.refusal ?? null;
  }

  /**
   * Host: another tab took over. Leave the room, so guests only hear the tab
   * that has `canvas serve`; the next welcome joins it again.
   */
  private stepDown() {
    this.leaveTransport();
    this.record({ level: "info", source: "relay", text: "left the room: another tab is the host" });
    this.identities.clear();
    this.admissions.clear();
    this.refreshKnocks();
    this.refreshTrusted();
    this.fingerprints = {};
    this.signedList = null;
    for (const approval of [...this.approvals]) approval.resolve(false);
  }

  /** Host only: answer a tool-call permission the agent asked for. */
  answerPermission(
    sessionId: string,
    requestId: string,
    optionId: string | null,
    at: UncheckedAddress = {},
  ) {
    if (reach(at, this.runtime) !== "own") return;
    this.server?.send({
      t: "agent-permission",
      sessionId,
      requestId,
      optionId,
      by: this.identity.name,
    });
  }

  /** Host only: a terminal follows the host's frame size. */
  resizeTerminal(pty: string, cols: number, rows: number, at: UncheckedAddress = {}) {
    if (reach(at, this.runtime) !== "own") return;
    this.server?.send({ t: "term-resize", pty, cols, rows });
  }

  /** Host: `canvas serve`'s member list, and what it changes for who is connected. */
  private setMembers(members: ReadonlyArray<Member>) {
    this.members = members;
    this.run(this.admissions.setMembers(members));
    this.refreshTrusted();
  }

  private refreshPeers() {
    this.peerList = this.peers();
    this.emit("peers");
  }

  /** By the peer each Yjs client came from, not the peer id it claims in its presence. */
  private peers(): Peer[] {
    const peerOf = new Map<number, string>();
    for (const [peerId, ids] of this.peerClients) for (const id of ids) peerOf.set(id, peerId);
    return [...this.awareness.getStates().entries()]
      .filter(([id, state]) => id !== this.doc.clientID && (state as Presence).user)
      .map(([id, state]) => {
        const peerId = peerOf.get(id);
        return { ...(state as Presence), fingerprint: peerId ? this.fingerprintOf(peerId) : null };
      });
  }

  destroy() {
    if (this.relayWatch) clearInterval(this.relayWatch);
    this.server?.close();
    this.transport?.leave();
    this.awareness.destroy();
  }
}

/** Host: how tall our board is on screen — what full screen shows frames at. */
const boardHeight = () =>
  document.querySelector("[data-board]")?.clientHeight || globalThis.innerHeight || 0;

type AgentOptions = ReadonlyArray<AgentConfigOption>;

/** Something mirrored, with its address as writers write it and its id there. */
type Mirrored<T> = T & { readonly at: Address; readonly id: string };

interface MirroredSession {
  /** Its runtime, as writers write it: none for the board's own. */
  readonly at: Address;
  meta: SessionMeta;
  events: AgentEvent[];
  /**
   * Its log is on its way (null once here). Guests: the live events that
   * came meanwhile, by place, to follow the history.
   */
  pending: Placed[] | null;
  options: ReadonlyArray<AgentConfigOption> | undefined;
  version: number;
}

interface Hello {
  readonly signature: string;
  /** For the guest to sign, proving its browser key. */
  readonly nonce: string;
}

/** A guest's answer to the hello: its proof, and the name it knocks with. */
interface Identify extends PeerProof, Identity {}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}
