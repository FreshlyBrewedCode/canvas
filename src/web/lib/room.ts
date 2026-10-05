/**
 * One board session in the browser: the Yjs doc and the parts of the room
 * that act on it, each a role of ADR 0013 (decision 2):
 *
 *  - `room/participant.ts`: this browser, host or guest — the transport to
 *    the other peers, presence, frame focus, connection details, and the
 *    actions that are the same for everyone (`act`);
 *  - `room/authority.ts` (host only): orders and checks the guests' updates,
 *    admission, the member list, handover, guests' requests, `tidy` — with
 *    no DOM, so it can move into `canvas serve` later;
 *  - `room/gateway.ts` (host only): the link to `canvas serve`;
 *  - `room/mirror.ts`: what this browser knows of the sessions, terminals
 *    and files only a runtime has; the gateway fills the host's, the host
 *    the guests'.
 *
 * `Room` puts them together and keeps the one API components use (`useRoom`).
 */

import { selfId } from "trystero";
import * as Y from "yjs";

import type { UncheckedAddress } from "../../shared/address";
import type { PeerIdentity } from "../../shared/identity";
import type {
  AgentKind,
  FileContent,
  GuestAccess,
  GuestRequest,
  Member,
  MemberRole,
  RoomState,
  SessionMeta,
} from "../../shared/protocol";
import type { Knock } from "./admission";
import { frameReach, type Frame } from "./board";
import type { ConnectionEvent, RelayInfo } from "./connection";
import type { FrameScroll, TreeView } from "./focus";
import type { BrowserKey } from "./identity-key";
import type { BoardLink, Identity, RelayLink } from "./link";
import type { LinkStatus } from "./server-link";
import { Authority, type Approval } from "./room/authority";
import { Gateway, type Welcome } from "./room/gateway";
import { Mirror, type AgentOptions, type MirroredSession } from "./room/mirror";
import {
  Participant,
  boardHeight,
  type AdmissionStatus,
  type FrameFocus,
  type Peer,
  type Presence,
} from "./room/participant";
import { addressOf } from "./room/reach";
import { Emitter, type Topic } from "./room/topics";

export type { Approval } from "./room/authority";
export type {
  AdmissionStatus,
  FrameFocus,
  LineSelection,
  Peer,
  Presence,
  Selection,
  TextSelection,
} from "./room/participant";

export class Room {
  readonly doc = new Y.Doc();
  readonly selfId = selfId;
  /** This browser in the room: presence, focus, the transport (`room/participant.ts`). */
  readonly participant: Participant;
  private readonly emitter = new Emitter();
  private readonly mirror: Mirror;
  /** Host: the board's authority (`room/authority.ts`). */
  private readonly authority: Authority | null = null;
  /** Host: the link to `canvas serve` (`room/gateway.ts`). */
  private readonly gateway: Gateway | null = null;

  constructor(link: BoardLink, identity: Identity, key: BrowserKey) {
    const { doc, emitter } = this;
    const mirror = (this.mirror = new Mirror(emitter, {
      host: link.host !== null,
      runtime: () => this.runtime,
      onGap: (sessionId) => participant.askLog(sessionId),
    }));
    const participant = (this.participant = new Participant({
      link,
      identity,
      key,
      doc,
      mirror,
      emitter,
    }));
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (this.authority) {
        this.authority.onUpdate(update, origin);
        this.gateway!.sync();
      } else participant.onUpdate(update, origin);
    });
    if (!link.host) {
      participant.join();
      return;
    }

    const emit = (topic: Topic) => emitter.emit(topic);
    const record = (event: Omit<ConnectionEvent, "at">) => participant.record(event);
    const state = () => participant.roomState;
    const gateway = (this.gateway = new Gateway(link, key, {
      doc,
      mirror,
      state,
      events: {
        welcome: (message) => this.welcome(message),
        members: (members) => authority.setMembers(members),
        room: (room, relay) => authority.reset(room, relay),
        forward: (message, to) => authority.hostcast(message, to),
        claim: (sessionId, agentFrame, frameId) =>
          participant.claimForAgent(sessionId, agentFrame, frameId),
        idle: (sessionId) => participant.releaseAgent(sessionId),
        // Leave the room, so guests only hear the tab that has `canvas serve`; the next welcome joins it again.
        replaced: () => {
          participant.leaveTransport();
          authority.stepDown();
        },
        record,
        emit,
      },
    }));
    const authority = (this.authority = new Authority({
      doc,
      mirror,
      selfId,
      fingerprint: participant.fingerprint,
      identity: participant.identity,
      link: () => participant.link,
      state,
      presence: {
        send: (peers) => participant.sendPresence(peers),
        drop: (peerId) => participant.dropPresence(peerId),
        nameOf: (peerId) => participant.nameOf(peerId),
        showFingerprints: (fingerprints) => participant.setFingerprints(fingerprints),
      },
      runtime: gateway,
      relocate: (next) => participant.relocate(next),
      screen: boardHeight,
      emit,
      record,
    }));
    participant.host = authority;
  }

  /** Host: `canvas serve` welcomed us: the board, its sessions, its members; then we join. */
  private welcome(message: Welcome) {
    const { participant, mirror } = this;
    const authority = this.authority!;
    authority.welcome(message.room.hostPrivateKey, message.relay ?? null);
    // The invite link was reset since this link was made: the room is `canvas serve`'s.
    const { roomId, key } = message.room;
    if (roomId !== participant.link.roomId || key !== participant.link.key)
      participant.relocate({ ...participant.link, roomId, key });
    authority.load(message.board);
    // Heads only: the logs of the sessions frames show are asked for (`Gateway.sync`).
    mirror.welcome(message.sessions, message.kindOptions);
    participant.welcomed({
      hostPeerId: selfId,
      runtime: message.runtime,
      cwd: message.cwd,
      agents: message.agents,
      version: message.version,
    });
    authority.setMembers(message.members);
    participant.join();
    this.gateway!.sync();
    authority.resync();
  }

  // -------------------------------------------------------------------------
  // the room

  get awareness() {
    return this.participant.awareness;
  }
  get isHost(): boolean {
    return this.participant.isHost;
  }
  get identity(): Identity {
    return this.participant.identity;
  }
  /** This browser's key's fingerprint (`identity-key.ts`); also says which comments are ours. */
  get fingerprint(): string {
    return this.participant.fingerprint;
  }
  /** The room we are in: the link's, until the invite link is reset. */
  get link(): BoardLink {
    return this.participant.link;
  }
  /** The host's from the welcome; a guest's once the host lets it in. */
  get roomState(): RoomState | null {
    return this.participant.roomState;
  }
  get serverStatus(): LinkStatus | null {
    return this.gateway?.status ?? null;
  }
  get hostOnline(): boolean {
    return this.participant.hostOnline;
  }
  /** Guests: whether the host let us in. */
  get admission(): AdmissionStatus {
    return this.participant.admission;
  }
  /** Guests: what the host lets us do; null until we are in. */
  get access(): GuestAccess | null {
    return this.participant.access;
  }
  /** Whether every session's head is here (the welcome's, or the host's `sessions`). */
  get sessionsKnown(): boolean {
    return this.mirror.known;
  }
  /** Everyone else's presence; a new array on every change. */
  get peerList(): Peer[] {
    return this.participant.peerList;
  }
  /** What happened to the connection, and every error (`connection.ts`); a new array on every change. */
  get log(): ConnectionEvent[] {
    return this.participant.log;
  }
  /** When we joined the room. */
  get joinedAt(): number | null {
    return this.participant.joinedAt;
  }

  subscribe(topic: Topic, listener: () => void): () => void {
    return this.emitter.subscribe(topic, listener);
  }

  /**
   * The board's own runtime's id (ADR 0013, decision 3): what an absent
   * `runtime` means; null until the welcome, or the host, says.
   */
  get runtime(): string | null {
    return this.participant.roomState?.runtime ?? null;
  }

  /** Where a frame's agent, file or terminal is, from here (`frameReach`). */
  reachOf(frame: Frame) {
    return frameReach(frame, this.runtime);
  }

  /** A frame's address as writers write it (ADR 0013): what its messages and links name. */
  addressOf(frame: Frame) {
    return addressOf(frame, this.runtime);
  }

  // -------------------------------------------------------------------------
  // sessions, terminals, files (`room/mirror.ts`)

  /** The key what is at `at` named `id` is mirrored under (`addressKey`). */
  keyOf(at: UncheckedAddress, id: string): string {
    return this.mirror.keyOf(at, id);
  }

  /** The topic that says a session, a terminal or a file of `at` changed. */
  topic(kind: "session" | "term" | "file", at: UncheckedAddress, id: string): Topic {
    return `${kind}:${this.keyOf(at, id)}`;
  }

  /** A session of the runtime `at` names (absent: the board's own). */
  session(id: string, at: UncheckedAddress = {}): MirroredSession | undefined {
    return this.mirror.session(id, at);
  }

  /** The settings a kind of agent offers a new session; undefined until known. */
  kindOptions(agent: AgentKind, at: UncheckedAddress = {}): AgentOptions | undefined {
    return this.mirror.kindOptions(agent, at);
  }

  /**
   * A session's settings; for one not begun, those its frame's agent offers,
   * at the values the frame starts it with.
   */
  optionsFor(sessionId: string, at: UncheckedAddress = {}): AgentOptions | undefined {
    return this.participant.optionsFor(sessionId, at);
  }

  /**
   * Every session of the board on the runtime `at` names (ADR 0012), the
   * last active first: heads only, logs come when a frame shows one. The
   * same array until one changes. `frameSessions` (`sessions.ts`) picks a frame's.
   */
  sessionMetas(at: UncheckedAddress = {}): ReadonlyArray<SessionMeta> {
    return this.mirror.sessionMetas(at);
  }

  /**
   * Sessions blocked on a permission only the host can answer, with the
   * frame of their turn: "needs you" points there if no frame shows them
   * (`waitingFrames`, `sessions.ts`).
   */
  waitingSessions(): Array<{ readonly id: string; readonly frameId: string }> {
    return this.mirror.waitingSessions();
  }

  /** A PTY's output so far, of the runtime `at` names. */
  terminal(pty: string, at: UncheckedAddress = {}): string {
    return this.mirror.terminal(pty, at);
  }

  /** A file of the runtime and root `at` names; undefined until it arrives. */
  file(path: string, at: UncheckedAddress = {}): FileContent | undefined {
    return this.mirror.file(path, at);
  }

  /** A root's file list; null until the host sends it (never to `view` guests). */
  tree(at: UncheckedAddress = {}): ReadonlyArray<string> | null {
    return this.mirror.tree(at);
  }

  /** A new conversation in an agent frame (ADR 0012, decision 4); its id, if there is such a frame. */
  newConversation(frameId: string): string | undefined {
    return this.participant.newConversation(frameId);
  }

  /** An agent frame shows another of the board's sessions (decision 1); a change of the board. */
  showConversation(frameId: string, sessionId: string) {
    this.participant.showConversation(frameId, sessionId);
  }

  // -------------------------------------------------------------------------
  // presence and frame focus (`room/participant.ts`)

  setPresence(patch: Partial<Omit<Presence, "user">>) {
    this.participant.setPresence(patch);
  }

  rename(identity: Identity) {
    this.participant.rename(identity);
  }

  /** Who occupies a frame, and whether we follow them there. */
  frameFocus(frameId: string): FrameFocus {
    return this.participant.frameFocus(frameId);
  }

  /** The occupant's scroll, for following it. */
  occupantScroll(frameId: string): FrameScroll | null {
    return this.participant.occupantScroll(frameId);
  }

  /** The occupant's tree panel, for following it. */
  occupantTree(frameId: string): TreeView | null {
    return this.participant.occupantTree(frameId);
  }

  /** Pressed on a frame (or, with null, on the board): claim it, or follow whoever is there. */
  focusFrame(frameId: string | null) {
    this.participant.focusFrame(frameId);
  }

  /** The frame we last pressed on, if it is still ours to be in. */
  ownFrame(): string | null {
    return this.participant.ownFrame();
  }

  /** We occupy the frame: tell followers where we scrolled it. */
  publishScroll(frameId: string, scroll: FrameScroll) {
    this.participant.publishScroll(frameId, scroll);
  }

  /** We occupy the frame: tell followers how we have its tree panel. */
  publishTree(frameId: string, patch: Partial<TreeView>) {
    this.participant.publishTree(frameId, patch);
  }

  /** We scrolled a frame someone else occupies: stop following them there. */
  detach(frameId: string) {
    this.participant.detach(frameId);
  }

  /** Back to following whoever occupies the frame. */
  follow(frameId: string) {
    this.participant.follow(frameId);
  }

  /** Host: an agent works on a frame now, unless a person occupies it. */
  claimForAgent(sessionId: string, agentFrame: string, frameId: string) {
    this.participant.claimForAgent(sessionId, agentFrame, frameId);
  }

  /** Host: an agent is done (its turn ended, or it closed its frame). */
  releaseAgent(sessionId: string) {
    this.participant.releaseAgent(sessionId);
  }

  /** The fingerprint `peerId` verified with; null if it hasn't (yet). */
  fingerprintOf(peerId: string): string | null {
    return this.participant.fingerprintOf(peerId);
  }

  // -------------------------------------------------------------------------
  // connection details (`connection.ts`)

  /** How peers reach each other here (ADR 0008), once joined. */
  transportKind() {
    return this.participant.transportKind();
  }

  /** The relays the transport uses — signalling, or the one carrying everything — and their state. */
  relays(): RelayInfo[] {
    return this.participant.relays();
  }

  /** The peers we can reach now. */
  peerIds(): string[] {
    return this.participant.peerIds();
  }

  /** The connected peers' WebRTC connections, by peer id; none over the relay transport. */
  peerConnections(): Readonly<Record<string, RTCPeerConnection>> {
    return this.participant.peerConnections();
  }

  // -------------------------------------------------------------------------
  // actions — the same API for host and guests

  /** Run something on the host's machine: directly as host, as a request as guest. */
  act(request: GuestRequest): Promise<void> {
    return this.participant.act(request);
  }

  // -------------------------------------------------------------------------
  // host: members, admission, handover (`room/authority.ts`)

  get approvals(): Approval[] {
    return this.authority?.approvals ?? NO_APPROVALS;
  }
  /** Host: the members `canvas serve` keeps; a new array on every change. */
  get members(): ReadonlyArray<Member> {
    return this.authority?.members ?? NONE;
  }
  /** Host: the fingerprints of the members trusted this session (decision 4); a new array on every change. */
  get trusted(): ReadonlyArray<string> {
    return this.authority?.trusted ?? NONE;
  }
  /** Host: who waits in the lobby; a new array on every change. */
  get knocks(): Knock[] {
    return this.authority?.knocks ?? NO_KNOCKS;
  }

  /** Host: let a knocking peer in, as a member with `role`; `canvas serve` saves it. */
  admit(peerId: string, role: MemberRole) {
    this.authority?.admit(peerId, role);
  }

  /** Host: turn a knocking peer away. */
  deny(peerId: string) {
    this.authority?.deny(peerId);
  }

  /** Host: what a member may do from now on. */
  setRole(fingerprint: string, role: MemberRole) {
    this.authority?.setRole(fingerprint, role);
  }

  /** Host: trust a member, or take it back (decision 4); it lasts while this tab is the host. */
  trust(fingerprint: string, on: boolean) {
    this.authority?.trust(fingerprint, on);
  }

  /** Host: a member is out, at once; `canvas serve` resets the invite link too. */
  removeMember(fingerprint: string) {
    this.authority?.removeMember(fingerprint);
  }

  /** Host: a new invite link (decision 6). Members here move along; links from before lead nowhere. */
  resetInviteLink() {
    this.authority?.resetInviteLink();
  }

  /** Host: the key `peerId` proved it holds, if it has. */
  verifiedPeer(peerId: string): PeerIdentity | undefined {
    return this.authority?.verifiedPeer(peerId);
  }

  /** The room guest links name: after a reset, the new one at once, while members move there. */
  inviteRoom(): BoardLink {
    return this.authority?.next ?? this.participant.link;
  }

  /** The relay guest links name, with the guest token; null for a board without one. */
  guestRelay(): RelayLink | null {
    return this.authority ? this.authority.guestRelay() : this.participant.link.relay;
  }

  // -------------------------------------------------------------------------
  // host: `canvas serve` (`room/gateway.ts`)

  /** Host: be the host again after another tab took over (it steps down in turn). */
  takeOver() {
    this.gateway?.takeOver();
  }

  /** Host: why `canvas serve` refused this browser, if it did. */
  get serverRefusal(): string | null {
    return this.gateway?.refusal ?? null;
  }

  /** Host only: answer a tool-call permission the agent asked for. */
  answerPermission(
    sessionId: string,
    requestId: string,
    optionId: string | null,
    at: UncheckedAddress = {},
  ) {
    this.gateway?.answerPermission(sessionId, requestId, optionId, this.identity.name, at);
  }

  /** Host only: a terminal follows the host's frame size. */
  resizeTerminal(pty: string, cols: number, rows: number, at: UncheckedAddress = {}) {
    this.gateway?.resizeTerminal(pty, cols, rows, at);
  }

  destroy() {
    this.gateway?.close();
    this.participant.destroy();
  }
}

/* A guest's: no host's lists, the same arrays every time (`useSyncExternalStore`). */
const NONE: ReadonlyArray<never> = [];
const NO_APPROVALS: Approval[] = [];
const NO_KNOCKS: Knock[] = [];
