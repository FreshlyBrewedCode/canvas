/**
 * One board session in the browser: the Yjs doc, presence, the transport to
 * the other peers (`transport/`, ADR 0008) and — for the host — the link to
 * `canvas serve`.
 *
 * Topology. Presence (cursors, selections, frame focus) is a full mesh: every peer
 * broadcasts to every other. Everything with authority is a star around the
 * host's browser:
 *
 *  - board updates: guests send theirs to the host only; the host applies
 *    what the guest's access allows and re-broadcasts. A read-only guest's
 *    edits therefore never reach anyone.
 *  - agent threads, terminals and files: only the host has them (from the
 *    server); it mirrors them to guests. A file frame's path in the board is
 *    only a request — what the server lets out is the shared set (ADR 0002).
 *  - anything that runs on the host's machine is a request to the host,
 *    checked against the room's access policy, possibly waiting for the host
 *    to approve it.
 *
 * Guests only accept host traffic from the peer that proved it holds the
 * board's host key (see `host-key.ts`). Every guest in turn proves its
 * browser's key to the host (ADR 0011, `shared/identity.ts`), which tells
 * everyone whose fingerprint each peer verified with.
 */

import { selfId } from "trystero";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type {
  AgentConfigOption,
  AgentEvent,
  FileContent,
  GuestAccess,
  GuestReply,
  GuestRequest,
  HostBroadcast,
  RoomState,
  ServerToClient,
  SessionHead,
  SessionMeta,
  ToolImage,
  WelcomeRelay,
} from "../../shared/protocol";
import { allFrames, tidy, type Frame } from "./board";
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
import { drawingImage, prepareDrawCall } from "./drawing-kit";
import type { ConnectionEvent, RelayInfo } from "./connection";
import { signHost, verifyHost } from "./host-key";
import { provePeer, type BrowserKey } from "./identity-key";
import { forgetPairingCode, type BoardLink, type Identity, type RelayLink } from "./link";
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

type Topic =
  | "room"
  | "approvals"
  | "connection"
  | "peers"
  | "focus"
  | "tree"
  /** Any session's status. */
  | "sessions"
  | `session:${string}`
  | `term:${string}`
  | `file:${string}`;

const APP_ID = "canvas-prototype-v1";
const LOG_LIMIT = 300;
const TERM_SCROLLBACK = 200_000;
const json = <T>(value: T) => value as never;

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly isHost: boolean;
  /** This browser's key's fingerprint (`identity-key.ts`); also says which comments are ours. */
  readonly fingerprint: string;
  readonly selfId = selfId;

  roomState: RoomState | null = null;
  serverStatus: LinkStatus | null = null;
  hostOnline = false;
  approvals: Approval[] = [];
  /** Everyone else's presence; a new array on every change. */
  peerList: Peer[] = [];
  /** What happened to the connection, and every error (`connection.ts`); a new array on every change. */
  log: ConnectionEvent[] = [];
  /** When we joined the room. */
  joinedAt: number | null = null;
  /** Host: the board's relay (ADR 0008) as `canvas serve` set it up for this tab. */
  private relaySetup: WelcomeRelay | null = null;

  private readonly sessions = new Map<string, MirroredSession>();
  private readonly terminals = new Map<string, string>();
  private readonly files = new Map<string, FileContent>();
  /** The shared set's file list; null until the host sends it (never to `view` guests). */
  private treePaths: ReadonlyArray<string> | null = null;
  private readonly listeners = new Map<Topic, Set<() => void>>();
  private readonly peerClients = new Map<string, Set<number>>();
  private readonly server: ServerLink | null = null;
  private hostPrivateKey: JsonWebKey | null = null;
  /** Host: who each guest proved to be. */
  private readonly identities: PeerIdentities;
  /** Verified fingerprints by peer id: the host's own book, or as the host told us. */
  private fingerprints: Readonly<Record<string, string>> = {};
  private transport: Transport | null = null;
  private actions: ReturnType<Room["makeActions"]> | null = null;
  private access: GuestAccess = "edit";
  /** Paths opened with the server since the link came up. */
  private readonly watched = new Set<string>();
  private treeWatched = false;
  /** Terminals opened and agent sessions ensured since the server link came up. */
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

  constructor(
    readonly link: BoardLink,
    readonly identity: Identity,
    private readonly key: BrowserKey,
  ) {
    this.isHost = link.host !== null;
    this.fingerprint = key.fingerprint;
    this.identities = new PeerIdentities(link.roomId);
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
          signature: await key.sign(ownerStatement(link.roomId, nonce)),
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

  // -------------------------------------------------------------------------
  // subscriptions

  subscribe(topic: Topic, listener: () => void): () => void {
    let set = this.listeners.get(topic);
    if (!set) this.listeners.set(topic, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  private emit(topic: Topic) {
    for (const listener of this.listeners.get(topic) ?? []) listener();
  }

  session(id: string) {
    return this.sessions.get(id);
  }

  /** Sessions blocked on a permission only the host can answer. */
  waitingSessions(): string[] {
    return [...this.sessions.values()]
      .filter((s) => s.meta.status === "waiting")
      .map((s) => s.meta.id);
  }

  terminal(id: string): string {
    return this.terminals.get(id) ?? "";
  }

  file(path: string): FileContent | undefined {
    return this.files.get(path);
  }

  tree(): ReadonlyArray<string> | null {
    return this.treePaths;
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

  /** Host: an agent works on a frame now, unless a person occupies it. */
  claimForAgent(sessionId: string, frameId: string) {
    if (!this.isHost) return;
    if (this.occupants.get(frameId)?.kind === "person") return this.releaseAgent(sessionId);
    const others = this.agentClaims.filter((c) => c.sessionId !== sessionId);
    this.agentClaims = [...others, { sessionId, frameId, since: Date.now() }];
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
      (sessionId) => titles.get(sessionId),
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
    if (origin === "local" && this.actions) {
      void this.actions.presence.send(encodeAwarenessUpdate(this.awareness, changed));
    }
  }

  // -------------------------------------------------------------------------
  // peers (`transport/`)

  private makeActions(transport: Transport) {
    return {
      hello: transport.channel("hello"),
      identify: transport.channel("identify"),
      state: transport.channel("state"),
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
      void actions.presence.send(encodeAwarenessUpdate(this.awareness, [this.doc.clientID]), {
        target: peerId,
      });
      if (this.isHost) void this.greet(peerId);
    };
    room.onPeerLeave = (peerId) => {
      this.record({ level: "info", source: "peer", text: "peer left", peerId });
      removeAwarenessStates(this.awareness, [...(this.peerClients.get(peerId) ?? [])], "leave");
      this.peerClients.delete(peerId);
      if (this.isHost) {
        this.identities.forget(peerId);
        this.publishIdentities();
      }
      if (peerId === this.roomState?.hostPeerId && !this.isHost) {
        this.record({ level: "warn", source: "host", text: "host left", peerId });
        this.hostOnline = false;
        this.emit("room");
      }
    };

    actions.presence.onMessage = (update, { peerId }) =>
      applyAwarenessUpdate(this.awareness, new Uint8Array(update), peerId);

    // The host's hello carries everything a guest needs to start, so nothing
    // arrives while the (async) signature check is still running.
    actions.hello.onMessage = async (message, { peerId }) => {
      const { signature, state, vector, nonce } = message as unknown as Hello;
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
      this.hostOnline = true;
      this.roomState = state;
      this.emit("room");
      void actions.update.send(Y.encodeStateAsUpdate(this.doc, Uint8Array.from(vector)), {
        target: peerId,
      });
      void actions.sync.send(Y.encodeStateVector(this.doc), { target: peerId });
      const proof = await provePeer(this.key, this.link.roomId, selfId, nonce);
      void actions.identify.send(json(proof), { target: peerId });
    };

    // A guest's answer to the nonce in our hello: who it is.
    actions.identify.onMessage = async (proof, { peerId }) => {
      if (!this.isHost) return;
      const identity = await this.identities.prove(peerId, proof as unknown as PeerProof);
      if (!identity) {
        this.record({
          level: "error",
          source: "peer",
          text: "a peer's proof of its browser key doesn't verify",
          peerId,
        });
        return;
      }
      this.publishIdentities();
    };

    actions.state.onMessage = (state, { peerId }) => {
      if (!this.fromHost(peerId)) return;
      this.roomState = state as unknown as RoomState;
      this.emit("room");
    };

    actions.broadcast.onMessage = (message, { peerId }) => {
      if (this.fromHost(peerId)) this.applyBroadcast(message as unknown as HostBroadcast);
    };

    // A state vector asks for everything the sender is missing.
    actions.sync.onMessage = (vector, { peerId }) => {
      if (!this.isHost && !this.fromHost(peerId)) return;
      void actions.update.send(Y.encodeStateAsUpdate(this.doc, new Uint8Array(vector)), {
        target: peerId,
      });
      if (this.isHost) void this.sendSnapshot(peerId);
    };

    actions.update.onMessage = (update, { peerId }) => {
      if (this.isHost) {
        if (this.access === "view") return;
        Y.applyUpdate(this.doc, new Uint8Array(update), { peer: peerId });
      } else if (this.fromHost(peerId)) {
        Y.applyUpdate(this.doc, new Uint8Array(update), "host");
      }
    };

    actions.request.onRequest = async (request, { peerId }) =>
      json(await this.onGuestRequest(peerId, request as unknown as GuestRequest));
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
    return this.hostOnline && this.roomState?.hostPeerId === peerId;
  }

  /** Host: prove who we are to a new peer, then bring it up to date. */
  private async greet(peerId: string) {
    if (!this.actions || !this.hostPrivateKey) return;
    if (!this.roomState) return;
    const hello: Hello = {
      signature: await signHost(this.hostPrivateKey, this.link.roomId, selfId),
      state: this.roomState,
      vector: [...Y.encodeStateVector(this.doc)],
      nonce: this.identities.challenge(peerId),
    };
    await this.actions.hello.send(json(hello), { target: peerId });
  }

  /** Host: tell everyone the fingerprints we verified, ours included. */
  private publishIdentities() {
    this.setFingerprints(this.verifiedFingerprints());
    this.hostcast({ t: "identities", fingerprints: this.fingerprints });
  }

  private verifiedFingerprints() {
    return { ...this.identities.fingerprints(), [selfId]: this.fingerprint };
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
   * Host: bring a guest up to date. Session heads go first, then each
   * session's history, shortest first, then terminals, files and the tree —
   * one message at a time, as messages sent together share the channel and
   * all arrive late.
   */
  private async sendSnapshot(peerId: string) {
    const actions = this.actions;
    if (!actions) return;
    // A closed frame's session stays with the host: nothing on the board shows it.
    const onBoard = new Set(this.frames().flatMap((f) => (f.type === "agent" ? [f.id] : [])));
    const sessions = [...this.sessions.values()].filter((s) => onBoard.has(s.meta.id));
    // All taken now: what changes from here on reaches the guest live.
    const messages: HostBroadcast[] = [
      {
        t: "sessions",
        sessions: sessions.map(({ meta, options }) => ({ meta, ...(options && { options }) })),
      },
      ...sessions
        .map((s) => ({ sessionId: s.meta.id, events: s.events.slice() }))
        .sort((a, b) => a.events.length - b.events.length)
        .map(({ sessionId, events }) => ({ t: "session-history" as const, sessionId, events })),
      ...[...this.terminals].map(([id, data]) => ({ t: "term-data" as const, id, data })),
      ...[...this.files].map(([path, file]) => ({ t: "file" as const, path, file })),
      ...(this.treePaths && this.access !== "view"
        ? [{ t: "tree" as const, paths: this.treePaths }]
        : []),
      { t: "identities", fingerprints: this.verifiedFingerprints() },
    ];
    try {
      for (const message of messages)
        await actions.broadcast.send(json(message), { target: peerId });
    } catch {
      // The guest left; it gets a new snapshot when it is back.
    }
  }

  private hostcast(message: HostBroadcast) {
    void this.actions?.broadcast.send(json(message));
  }

  private onDocUpdate(update: Uint8Array, origin: unknown) {
    if (this.isHost) {
      // Fan out to everyone but the guest it came from.
      const from =
        typeof origin === "object" && origin !== null && "peer" in origin
          ? (origin.peer as string)
          : null;
      const targets = this.peerIds().filter((id) => id !== from);
      if (targets.length) void this.actions?.update.send(update, { target: targets });
      if (origin !== "server") this.scheduleSave();
      this.scheduleTidy();
      this.syncResources();
    } else if (origin !== "host" && this.hostOnline && this.roomState) {
      void this.actions?.update.send(update, { target: this.roomState.hostPeerId });
    }
  }

  private applyBroadcast(message: HostBroadcast) {
    switch (message.t) {
      case "sessions":
        this.sessions.clear();
        for (const head of message.sessions) this.putSession(head, null);
        this.emit("sessions");
        return;
      case "session-history":
        return this.putHistory(message.sessionId, message.events);
      case "agent-meta":
        return this.putMeta(message.meta);
      case "agent-event":
        return this.pushEvent(message.sessionId, message.event);
      case "agent-options":
        return this.putOptions(message.sessionId, message.options);
      case "term-data":
        return this.pushTerm(message.id, message.data);
      case "file":
        return this.putFile(message.path, message.file);
      case "tree":
        return this.putTree(message.paths);
      case "identities":
        return this.setFingerprints(message.fingerprints);
    }
  }

  // -------------------------------------------------------------------------
  // sessions & terminals (local mirror)

  /** A session with its log, or (null) one whose history is still on its way. */
  private putSession(head: SessionHead, events: ReadonlyArray<AgentEvent> | null) {
    this.sessions.set(head.meta.id, {
      meta: head.meta,
      events: events ? [...events] : [],
      pending: events ? null : [],
      options: head.options,
      version: Date.now(),
    });
    this.emit(`session:${head.meta.id}`);
    this.emit("sessions");
  }

  /** A session's history arrived: it comes before what arrived live meanwhile. */
  private putHistory(sessionId: string, events: ReadonlyArray<AgentEvent>) {
    const session = this.sessions.get(sessionId);
    if (!session?.pending) return;
    session.events = [...events, ...session.pending];
    session.pending = null;
    session.version++;
    this.emit(`session:${sessionId}`);
  }

  private putMeta(meta: SessionMeta) {
    const session = this.sessions.get(meta.id);
    if (session) {
      session.meta = meta;
      session.version++;
    } else
      this.sessions.set(meta.id, {
        meta,
        events: [],
        pending: null,
        options: undefined,
        version: 0,
      });
    this.emit(`session:${meta.id}`);
    this.emit("sessions");
  }

  private putOptions(sessionId: string, options: ReadonlyArray<AgentConfigOption>) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.options = options;
    session.version++;
    this.emit(`session:${sessionId}`);
  }

  private pushEvent(sessionId: string, event: AgentEvent) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.pending) return void session.pending.push(event);
    session.events.push(event);
    session.version++;
    this.emit(`session:${sessionId}`);
  }

  private pushTerm(id: string, data: string) {
    this.terminals.set(id, (this.terminal(id) + data).slice(-TERM_SCROLLBACK));
    this.emit(`term:${id}`);
  }

  private putFile(path: string, file: FileContent) {
    this.files.set(path, file);
    this.emit(`file:${path}`);
  }

  private putTree(paths: ReadonlyArray<string>) {
    this.treePaths = paths;
    this.emit("tree");
  }

  // -------------------------------------------------------------------------
  // host ⇄ server

  private onServer(message: ServerToClient) {
    switch (message.t) {
      case "welcome": {
        this.hostPrivateKey = message.room.hostPrivateKey;
        this.relaySetup = message.relay ?? null;
        if (message.board)
          Y.applyUpdate(
            this.doc,
            Uint8Array.from(atob(message.board), (c) => c.charCodeAt(0)),
            "server",
          );
        // Boards from before the tree are migrated before anyone joins.
        tidy(this.doc, { screen: boardHeight() });
        this.sessions.clear();
        for (const snapshot of message.sessions) this.putSession(snapshot, snapshot.events);
        this.emit("sessions");
        this.roomState = {
          hostPeerId: selfId,
          access: this.access,
          cwd: message.cwd,
          agents: message.agents,
          version: message.version,
        };
        this.hostOnline = true;
        this.emit("room");
        this.join();
        this.syncResources();
        for (const peerId of this.peerIds()) void this.sendSnapshot(peerId);
        return;
      }
      case "agent-meta":
        this.putMeta(message.meta);
        // Its turn is over: it leaves the frame it worked on.
        if (message.meta.status === "idle") this.releaseAgent(message.meta.id);
        return this.hostcast(message);
      case "agent-event":
        this.pushEvent(message.sessionId, message.event);
        return this.hostcast(message);
      case "agent-options":
        this.putOptions(message.sessionId, message.options);
        return this.hostcast(message);
      case "term-data":
        this.pushTerm(message.id, message.data);
        return this.hostcast(message);
      case "term-exit": {
        const data = `\r\n\x1b[2m[process exited${message.code === null ? "" : ` with ${message.code}`}]\x1b[0m\r\n`;
        this.pushTerm(message.id, data);
        this.opened.delete(message.id);
        return this.hostcast({ t: "term-data", id: message.id, data });
      }
      case "file":
        this.putFile(message.path, message.file);
        return this.hostcast(message);
      case "tree":
        this.putTree(message.paths);
        if (this.access !== "view") this.hostcast(message);
        return;
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
          self: message.sessionId,
          agents: this.roomState?.agents ?? [],
          status: (id) => this.sessions.get(id)?.meta.status,
        },
        message.tool,
        args,
      );
      text = result.text;
      if (result.image) images = [await drawingImage(this.doc, result.image)];
      if (result.frame) this.claimForAgent(message.sessionId, result.frame);
    } catch (error) {
      ok = false;
      text = error instanceof Error ? error.message : String(error);
    }
    this.server?.send({ t: "board-result", callId: message.callId, ok, text, images });
  }

  /**
   * Host: make sure exactly the files the board shows are open, every
   * terminal is running and every agent frame that has its agent picked has
   * a session (which also brings up the agent, so its settings can be
   * listed).
   */
  private syncResources() {
    if (!this.isHost || this.server?.status !== "open") return;
    const frames = this.frames();
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
      if (frame.type === "agent" && frame.agent && !this.opened.has(frame.id)) {
        this.opened.add(frame.id);
        this.server.send({ t: "agent-create", id: frame.id, agent: frame.agent });
      }
      if (frame.type === "terminal" && !this.opened.has(frame.id)) {
        this.opened.add(frame.id);
        this.terminals.delete(frame.id);
        this.server.send({ t: "term-open", id: frame.id, cols: 80, rows: 24 });
      }
    }
  }

  // -------------------------------------------------------------------------
  // actions — the same API for host and guests

  /** Run something on the host's machine: directly as host, as a request as guest. */
  async act(request: GuestRequest): Promise<void> {
    if (this.isHost) return this.execute(request, this.identity);
    const hostPeerId = this.roomState?.hostPeerId;
    if (!this.actions || !hostPeerId || !this.hostOnline) throw new Error("the host is offline");
    const reply = (await this.actions.request.request(json(request), {
      target: hostPeerId,
      timeoutMs: 5 * 60_000,
    })) as unknown as GuestReply;
    if (!reply.ok) throw new Error(reply.error);
  }

  private execute(request: GuestRequest, author: Identity) {
    if (!this.server || this.server.status !== "open")
      throw new Error("not connected to canvas serve");
    switch (request.t) {
      case "agent-create":
        this.server.send({ t: "agent-create", id: request.frameId, agent: request.agent });
        return;
      case "agent-prompt": {
        const frame = this.frames().find((f) => f.id === request.sessionId);
        if (frame?.type !== "agent") throw new Error("no such agent frame");
        if (!this.sessions.has(frame.id))
          this.server.send({ t: "agent-create", id: frame.id, agent: frame.agent });
        const status = this.sessions.get(frame.id)?.meta.status;
        if (status && status !== "idle") throw new Error("the agent is still busy");
        this.server.send({ t: "agent-prompt", sessionId: frame.id, text: request.text, author });
        return;
      }
      case "agent-cancel":
        this.server.send({ t: "agent-cancel", sessionId: request.sessionId });
        return;
      case "agent-config":
        this.server.send({ ...request, t: "agent-config" });
        return;
      case "term-input":
        this.server.send({ t: "term-input", id: request.id, data: request.data });
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
      if (this.access === "view") throw new Error("the board is read-only for guests");
      if (request.t === "term-input" && this.access !== "trusted")
        throw new Error("typing into terminals needs trusted access");
      const needsApproval = this.access === "edit" && request.t !== "agent-cancel";
      if (needsApproval && !(await this.ask(peer, request)))
        throw new Error(`${this.identity.name} declined`);
      this.execute(request, peer);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private ask(peer: Identity, request: GuestRequest): Promise<boolean> {
    return new Promise((resolve) => {
      const approval: Approval = {
        id: crypto.randomUUID(),
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
    this.transport?.leave();
    this.transport = null;
    this.joinedAt = null;
    this.record({ level: "info", source: "relay", text: "left the room: another tab is the host" });
    this.actions = null;
    const clients = [...this.peerClients.values()].flatMap((ids) => [...ids]);
    removeAwarenessStates(this.awareness, clients, "leave");
    this.peerClients.clear();
    this.identities.clear();
    this.fingerprints = {};
    for (const approval of [...this.approvals]) approval.resolve(false);
  }

  /** Host only: answer a tool-call permission the agent asked for. */
  answerPermission(sessionId: string, requestId: string, optionId: string | null) {
    this.server?.send({
      t: "agent-permission",
      sessionId,
      requestId,
      optionId,
      by: this.identity.name,
    });
  }

  /** Host only: a terminal follows the host's frame size. */
  resizeTerminal(id: string, cols: number, rows: number) {
    this.server?.send({ t: "term-resize", id, cols, rows });
  }

  setAccess(access: GuestAccess) {
    if (!this.isHost || !this.roomState) return;
    const wasView = this.access === "view";
    this.access = access;
    this.roomState = { ...this.roomState, access };
    void this.actions?.state.send(json(this.roomState));
    // `view` guests never got the tree; now they may browse it.
    if (wasView && access !== "view" && this.treePaths)
      this.hostcast({ t: "tree", paths: this.treePaths });
    this.emit("room");
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

interface MirroredSession {
  meta: SessionMeta;
  events: AgentEvent[];
  /** Guests: live events held back until the session's history arrives; null once it has. */
  pending: AgentEvent[] | null;
  options: ReadonlyArray<AgentConfigOption> | undefined;
  version: number;
}

interface Hello {
  readonly signature: string;
  readonly state: RoomState;
  readonly vector: number[];
  /** For the guest to sign, proving its browser key. */
  readonly nonce: string;
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}
