/**
 * This browser in the room, host or guest (ADR 0013, decision 2: the
 * participant is each browser's, not the board's): the transport to the
 * other peers (`transport/`, ADR 0008), our presence and everyone else's,
 * frame focus, the connection details, and the actions that are the same
 * for host and guests (`act`).
 *
 * Presence (cursors, selections, frame focus) is a mesh between the peers
 * that are in: the host signs who they are (`member-list.ts`), and guests
 * send theirs only to peers on that list and take it only from them. The
 * host's authority (`authority.ts`) says who is in on its side.
 *
 * A guest takes host traffic only from the peer that proved it holds the
 * board's host key (`host-key.ts`), and proves its own browser's key to it
 * (ADR 0011, `shared/identity.ts`). It waits in the lobby until the host
 * lets it in; then the host mirrors the board's sessions, terminals and
 * files to it (`mirror.ts`). Resetting the invite link (ADR 0011, decision
 * 6) hands it the new room, sealed to it, and it moves there (`relocate`).
 */

import { selfId } from "trystero";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";

import { reach, type UncheckedAddress } from "../../../shared/address";
import type {
  Admission,
  GuestAccess,
  GuestRead,
  GuestReply,
  GuestRequest,
  HostBroadcast,
  RoomState,
  SignedMemberList,
} from "../../../shared/protocol";
import { allFrames, newConversation, showConversation, shownSession, type Frame } from "../board";
import type { ConnectionEvent, RelayInfo } from "../connection";
import type { DragGhost } from "../drag";
import {
  CLOSED_TREE,
  resolveOccupants,
  type AgentClaim,
  type Focus,
  type FrameScroll,
  type Occupant,
  type TreeView,
} from "../focus";
import { makeSealKey, openMove, type SealedMove } from "../handover";
import { verifyHost } from "../host-key";
import { provePeer, type BrowserKey } from "../identity-key";
import { showLink, type BoardLink, type Identity } from "../link";
import { Members } from "../member-list";
import { framesShowing, nextSettings, shownSessions, unbegunOptions } from "../sessions";
import { openTransport } from "../transport/open";
import type { Transport } from "../transport/transport";
import type { Authority } from "./authority";
import { json, type Channels, type Hello, type Identify } from "./channels";
import type { AgentOptions, Mirror } from "./mirror";
import { agentFrame, here } from "./reach";
import type { Emitter, Topic } from "./topics";

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

const APP_ID = "canvas-prototype-v1";
const LOG_LIMIT = 300;

/** Host: how tall our board is on screen — what full screen shows frames at. */
export const boardHeight = () =>
  document.querySelector("[data-board]")?.clientHeight || globalThis.innerHeight || 0;

export interface ParticipantOptions {
  readonly link: BoardLink;
  readonly identity: Identity;
  readonly key: BrowserKey;
  readonly doc: Y.Doc;
  readonly mirror: Mirror;
  readonly emitter: Emitter;
}

export class Participant {
  readonly awareness: Awareness;
  readonly isHost: boolean;
  readonly identity: Identity;
  readonly fingerprint: string;

  /** The host's from the welcome; a guest's once the host lets it in. */
  roomState: RoomState | null = null;
  hostOnline = false;
  /** Guests: whether the host let us in. */
  admission: AdmissionStatus = "connecting";
  /** Guests: what the host lets us do; null until we are in. */
  access: GuestAccess | null = null;
  /** Everyone else's presence; a new array on every change. */
  peerList: Peer[] = [];
  /** What happened to the connection, and every error (`connection.ts`); a new array on every change. */
  log: ConnectionEvent[] = [];
  /** When we joined the room. */
  joinedAt: number | null = null;

  /**
   * Host: the board's authority, in this tab; who is in is its to say. Set
   * once, before the host joins (at `canvas serve`'s welcome).
   */
  host: Authority | null = null;

  private readonly doc: Y.Doc;
  private readonly mirror: Mirror;
  private readonly emitter: Emitter;
  private readonly key: BrowserKey;
  private current: BoardLink;
  private transport: Transport | null = null;
  private actions: Channels | null = null;
  private readonly peerClients = new Map<string, Set<number>>();
  /** Guests: the peer that proved it is the host. */
  private hostPeer: string | null = null;
  /** Verified fingerprints by peer id: the host's own book, or as its member list says. */
  private fingerprints: Readonly<Record<string, string>> = {};
  /** Guests: the latest member list the host signed; whom presence goes to and comes from. */
  private memberList: Members;
  /** Guests: the last presence of peers not on the list (yet): the list may come after it. */
  private readonly heldPresence = new Map<string, Uint8Array>();
  /**
   * Guests: the sessions frames showed when the host last sent every head
   * (their logs come with them), then since; a session newly shown whose log
   * we lack is asked for. Null until the heads are here.
   */
  private shownHere: Set<string> | null = null;
  /** Guests: sessions whose log we asked the host for, until it comes. */
  private readonly asked = new Set<string>();
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

  constructor(options: ParticipantOptions) {
    this.isHost = options.link.host !== null;
    this.doc = options.doc;
    this.mirror = options.mirror;
    this.emitter = options.emitter;
    this.identity = options.identity;
    this.key = options.key;
    this.fingerprint = options.key.fingerprint;
    this.current = options.link;
    this.awareness = new Awareness(this.doc);
    this.memberList = new Members(options.link.roomId, options.link.hostPublicKey, selfId);
    this.setPresence({ pointer: null, view: null, selection: null, focus: null });
    this.awareness.on("change", () => {
      this.refreshPeers();
      this.onFocusChange();
    });
    this.awareness.on("update", ({ added, updated, removed }: AwarenessChange, origin: unknown) =>
      this.onAwareness([...added, ...updated, ...removed], added, origin),
    );
  }

  /** The room we are in: the link's, until the invite link is reset. */
  get link(): BoardLink {
    return this.current;
  }

  private get runtime(): string | null {
    return this.roomState?.runtime ?? null;
  }

  private emit(topic: Topic) {
    this.emitter.emit(topic);
  }

  /** Host: `canvas serve` welcomed us; the room is as it says. */
  welcomed(state: RoomState) {
    this.roomState = state;
    this.hostOnline = true;
    this.emit("room");
  }

  // -------------------------------------------------------------------------
  // the board's sessions, as this browser has them

  /**
   * A session's settings; for one not begun, those its frame's agent offers,
   * at the values the frame starts it with.
   */
  optionsFor(sessionId: string, at: UncheckedAddress = {}): AgentOptions | undefined {
    const session = this.mirror.session(sessionId, at);
    if (session) return session.options;
    if (reach(at, this.runtime) !== "own") return undefined;
    const frame = framesShowing(here(this.doc, this.runtime), sessionId)[0];
    return frame && unbegunOptions(this.mirror.kindOptions(frame.agent), frame);
  }

  /**
   * A new conversation in an agent frame (ADR 0012, decision 4): a fresh id
   * it shows, with the settings of the conversation it showed. Nothing runs
   * until its first prompt. A change of the board, so for whoever may edit
   * it; the new id, or undefined if there is no such agent frame.
   */
  newConversation(frameId: string): string | undefined {
    const frame = agentFrame(this.doc, frameId);
    if (!frame) return undefined;
    const shown = this.mirror.session(shownSession(frame), frame)?.meta;
    return newConversation(this.doc, frameId, nextSettings(frame, shown));
  }

  /** An agent frame shows another of the board's sessions (decision 1); a change of the board. */
  showConversation(frameId: string, sessionId: string) {
    showConversation(this.doc, frameId, sessionId);
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

  /** The fingerprint `peerId` verified with; null if it hasn't (yet). */
  fingerprintOf(peerId: string): string | null {
    return this.fingerprints[peerId] ?? null;
  }

  setFingerprints(fingerprints: Readonly<Record<string, string>>) {
    this.fingerprints = fingerprints;
    this.refreshPeers();
  }

  /** The name a peer shows in its presence; a stand-in if none. */
  nameOf(peerId: string): Identity {
    for (const id of this.peerClients.get(peerId) ?? []) {
      const state = this.awareness.getStates().get(id) as Presence | undefined;
      if (state?.user) return { name: state.user.name, color: state.user.color };
    }
    return { name: `guest ${peerId.slice(0, 4)}`, color: "#888888" };
  }

  sendPresence(peerId: string | ReadonlyArray<string>) {
    if (peerId.length === 0) return;
    void this.actions?.presence.send(encodeAwarenessUpdate(this.awareness, [this.doc.clientID]), {
      target: peerId,
    });
  }

  /** A peer's presence goes (it left, or is off the list). */
  dropPresence(peerId: string) {
    removeAwarenessStates(this.awareness, [...(this.peerClients.get(peerId) ?? [])], "leave");
    this.peerClients.delete(peerId);
    this.heldPresence.delete(peerId);
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
    const targets = this.host ? this.host.admitted() : this.presenceTargets();
    if (targets.length)
      void this.actions.presence.send(encodeAwarenessUpdate(this.awareness, changed), {
        target: targets,
      });
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
    const titles = new Map(allFrames(this.doc).map((f: Frame) => [f.id, f.title]));
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

  // -------------------------------------------------------------------------
  // peers (`transport/`)

  join() {
    if (this.transport) return;
    const relay = this.host ? this.host.ownRelay() : this.link.relay;
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
    const actions: Channels = {
      hello: room.channel("hello"),
      identify: room.channel("identify"),
      admission: room.channel("admission"),
      broadcast: room.channel("hostcast"),
      update: room.channel<Uint8Array>("yupdate"),
      sync: room.channel<Uint8Array>("ysync"),
      presence: room.channel<Uint8Array>("presence"),
      request: room.requests("request"),
    };
    this.actions = actions;
    // The host's side of the channels is its authority's: guests' answers, updates and requests.
    this.host?.attach({ channels: actions, peers: () => room.peers() });

    room.onPeerJoin = (peerId) => {
      this.record({ level: "info", source: "peer", text: "peer connected", peerId });
      // The host's presence goes to a guest once it is in (`letIn`).
      if (this.host) void this.host.arrive(peerId);
      else if (this.memberList.has(peerId)) this.sendPresence(peerId);
    };
    room.onPeerLeave = (peerId) => {
      this.record({ level: "info", source: "peer", text: "peer left", peerId });
      this.dropPresence(peerId);
      this.host?.leave(peerId);
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
      if (this.host ? this.host.isIn(peerId) : this.takesPresence(peerId))
        applyAwarenessUpdate(this.awareness, bytes, peerId);
      else if (!this.host) this.heldPresence.set(peerId, bytes);
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

    actions.admission.onMessage = (message, { peerId }) => {
      if (!this.isHost && this.fromHost(peerId)) this.onAdmission(message as unknown as Admission);
    };

    actions.broadcast.onMessage = (message, { peerId }) => {
      if (this.fromHost(peerId)) this.applyBroadcast(message as unknown as HostBroadcast);
    };

    if (this.host) return;

    // A state vector asks for everything the sender is missing.
    actions.sync.onMessage = (vector, { peerId }) => {
      if (!this.fromHost(peerId)) return;
      void actions.update.send(Y.encodeStateAsUpdate(this.doc, new Uint8Array(vector)), {
        target: peerId,
      });
    };

    actions.update.onMessage = (update, { peerId }) => {
      if (this.fromHost(peerId)) Y.applyUpdate(this.doc, new Uint8Array(update), "host");
    };
  }

  private fromHost(peerId: string) {
    return this.hostOnline && this.hostPeer === peerId;
  }

  /**
   * Into the room `next` names. The old room's peers are gone; who is in
   * comes again there, and the address bar shows it, so a reload comes back.
   * A guest stays in meanwhile: its board stays up, waiting for the host.
   */
  relocate(next: BoardLink) {
    const joined = this.transport !== null;
    this.leaveTransport();
    this.current = next;
    showLink(next);
    this.memberList = new Members(next.roomId, next.hostPublicKey, selfId);
    this.heldPresence.clear();
    this.setFingerprints({});
    if (this.host) {
      this.host.relocated(next);
    } else {
      this.hostPeer = null;
      this.hostOnline = false;
    }
    this.emit("room");
    if (joined) this.join();
  }

  /** Out of the room's transport: nobody's presence stays. */
  leaveTransport() {
    this.transport?.leave();
    this.transport = null;
    this.actions = null;
    this.host?.attach(null);
    this.joinedAt = null;
    const clients = [...this.peerClients.values()].flatMap((ids) => [...ids]);
    removeAwarenessStates(this.awareness, clients, "leave");
    this.peerClients.clear();
  }

  // -------------------------------------------------------------------------
  // guests: what the host says

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
    this.mirror.clear();
    this.shownHere = null;
    this.asked.clear();
    this.memberList.reset();
    this.heldPresence.clear();
    this.setFingerprints({});
    this.emit("sessions");
    this.emit("tree");
    this.emit("room");
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

  private applyBroadcast(message: HostBroadcast) {
    const mirror = this.mirror;
    switch (message.t) {
      case "sessions": {
        // Every head of one runtime: those we had of it go.
        mirror.heads(message, message.sessions);
        if (reach(message, this.runtime) === "own") {
          this.asked.clear();
          // The logs of the sessions frames show now come after this; others as frames show them.
          this.shownHere = shownSessions(here(this.doc, this.runtime));
        }
        this.emit("sessions");
        this.emit("room");
        return;
      }
      case "session-history":
        if (reach(message, this.runtime) === "own") this.asked.delete(message.sessionId);
        return mirror.putHistory(message, message.sessionId, message.events);
      case "kind-options":
        return mirror.putKind(message, message.agent, message.options);
      case "agent-meta":
        return mirror.putMeta(message, message.meta);
      case "agent-event":
        return void mirror.pushEvent(message, message.sessionId, message.event, message.index);
      case "agent-options":
        return mirror.putOptions(message, message.sessionId, message.options);
      case "term-data":
        return mirror.pushTerm(message, message.pty, message.data);
      case "file":
        return mirror.putFile(message, message.path, message.file);
      case "tree":
        return mirror.putTree(message, message.paths);
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

  /** Guests: our own change of the doc goes to the host, which decides. */
  onUpdate(update: Uint8Array, origin: unknown) {
    if (origin !== "host" && this.hostOnline && this.hostPeer && this.access)
      void this.actions?.update.send(update, { target: this.hostPeer });
    this.openShown();
  }

  /**
   * Guests: ask the host for the logs of sessions frames came to show since
   * the heads came (those the frames showed then come by themselves).
   */
  private openShown() {
    if (!this.shownHere) return;
    const shown = shownSessions(here(this.doc, this.runtime));
    for (const sessionId of shown)
      if (!this.shownHere.has(sessionId) && this.mirror.session(sessionId)?.pending)
        this.askLog(sessionId);
    this.shownHere = shown;
  }

  /** Guests: a session's log, from the host (`GuestRead`): it comes as a `session-history`. */
  askLog(sessionId: string) {
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
    if (this.host) return this.host.execute(request, this.identity);
    const hostPeerId = this.hostPeer;
    if (!this.actions || !hostPeerId || !this.hostOnline) throw new Error("the host is offline");
    const reply = (await this.actions.request.request(json(request), {
      target: hostPeerId,
      timeoutMs: 5 * 60_000,
    })) as unknown as GuestReply;
    if (!reply.ok) throw new Error(reply.error);
  }

  // -------------------------------------------------------------------------
  // connection details (`connection.ts`)

  record(event: Omit<ConnectionEvent, "at">) {
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

  destroy() {
    if (this.relayWatch) clearInterval(this.relayWatch);
    this.transport?.leave();
    this.awareness.destroy();
  }
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}
