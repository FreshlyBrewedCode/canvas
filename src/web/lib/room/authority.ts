/**
 * The board's authority (ADR 0013, decision 2), in the host's tab today:
 * everything with authority is a star around it.
 *
 *  - board updates: guests send theirs to the host only; it applies what the
 *    guest's role allows and sends it on to the others. A read-only guest's
 *    edits therefore never reach anyone. It keeps the board tidy (`tidy`)
 *    and has `canvas serve` save it.
 *  - admission (ADR 0011, decision 2, `admission.ts`): the guest link is an
 *    invite. A guest whose key isn't a member's waits in the lobby until the
 *    host lets it in; until then it gets nothing but its hello and `lobby`,
 *    and its updates, requests and presence are refused.
 *  - the member list (`member-list.ts`): the host signs who is in, so guests
 *    know whose presence to take.
 *  - handover (ADR 0011, decision 6, `handover.ts`): when `canvas serve`
 *    mints a new room, the members that are in get it, sealed to each.
 *  - guests' requests to run something on the host's machine: checked
 *    against the member's role, maybe waiting for the host to approve, then
 *    sent to the board's own runtime (`execute`).
 *
 * It depends on no DOM (`tsconfig.authority.json` checks it), so it can move
 * into `canvas serve` later. What it needs of the browser it runs in comes in
 * as `Surroundings`; it reaches guests on the channels the participant joined
 * (`attach`).
 */

import * as Y from "yjs";

import { reach } from "../../../shared/address";
import { PeerIdentities, type PeerIdentity } from "../../../shared/identity";
import type {
  Admission,
  ClientToServer,
  GuestAccess,
  GuestRead,
  GuestReply,
  GuestRequest,
  HostBroadcast,
  Member,
  MemberRole,
  RoomSecrets,
  RoomState,
  SignedMemberList,
  WelcomeRelay,
} from "../../../shared/protocol";
import { Admissions, check, mayEdit, type Knock, type Step } from "../admission";
import { allFrames, frameReach, tidy } from "../board";
import type { ConnectionEvent } from "../connection";
import { sealMove, type Move } from "../handover";
import { signHost } from "../host-key";
import type { BoardLink, Identity, RelayLink } from "../link-types";
import { nextVersion, signMembers } from "../member-list";
import { framesShowing, promptFrame, shownSessions, startIn } from "../sessions";
import { json, type Hello, type Identify, type Joined } from "./channels";
import type { Mirror } from "./mirror";
import { here } from "./reach";
import type { Topic } from "./topics";

/** How long the members have to leave for the new room before we follow. */
const MOVE_WAIT_MS = 3000;
export const NOT_REACHABLE = "not reachable: that is on another runtime";

export interface Approval {
  readonly id: string;
  readonly peerId: string;
  readonly peer: Identity;
  readonly request: GuestRequest;
  readonly resolve: (approved: boolean) => void;
}

/** This browser's presence, as the authority uses it (`participant.ts`). */
export interface Presences {
  /** Ours, to peers that are in. */
  send(peers: string | ReadonlyArray<string>): void;
  /** A peer's goes: it is out. */
  drop(peerId: string): void;
  /** The name a peer shows, for approvals. */
  nameOf(peerId: string): Identity;
  /** Whose fingerprint each peer verified with, for presence. */
  showFingerprints(fingerprints: Readonly<Record<string, string>>): void;
}

/** The way to the board's own runtime: `canvas serve`, through the gateway (`gateway.ts`). */
export interface RuntimeDoor {
  readonly open: boolean;
  /** Dropped while not open. */
  send(message: ClientToServer): void;
}

/** What the authority needs of where it runs. */
export interface Surroundings {
  readonly doc: Y.Doc;
  readonly mirror: Mirror;
  /** Our peer id: the host's, on the member list and in its hello. */
  readonly selfId: string;
  /** Our browser key's fingerprint, on the member list beside the guests'. */
  readonly fingerprint: string;
  /** The host's name: requests it runs are its, and it declines them. */
  readonly identity: Identity;
  /** The room we are in: the link's, until the invite link is reset. */
  readonly link: () => BoardLink;
  /** The room as the welcome said; null until then. */
  readonly state: () => RoomState | null;
  readonly presence: Presences;
  readonly runtime: RuntimeDoor;
  /** Into the room `next` names: we leave this one, and come again there (`relocated`). */
  readonly relocate: (next: BoardLink) => void;
  /** How tall the board is on screen: what full screen shows frames at (`tidy`). */
  readonly screen: () => number;
  readonly emit: (topic: Topic) => void;
  readonly record: (event: Omit<ConnectionEvent, "at">) => void;
}

export class Authority {
  approvals: Approval[] = [];
  /** The members `canvas serve` keeps; a new array on every change. */
  members: ReadonlyArray<Member> = [];
  /** The fingerprints of the members trusted this session (decision 4); a new array on every change. */
  trusted: ReadonlyArray<string> = [];
  /** Who waits in the lobby; a new array on every change. */
  knocks: Knock[] = [];
  /** The room being handed over, until we are there. */
  next: BoardLink | null = null;

  private readonly doc: Y.Doc;
  private readonly mirror: Mirror;
  private readonly presence: Presences;
  private readonly door: RuntimeDoor;
  private joined: Joined | null = null;
  private hostPrivateKey: JsonWebKey | null = null;
  /** The board's relay (ADR 0008) as `canvas serve` set it up for this tab. */
  private relay: WelcomeRelay | null = null;
  /** Who each guest proved to be, in this room. */
  private identities: PeerIdentities;
  /** Who is in, who knocks. */
  private readonly admissions = new Admissions();
  /** The verified fingerprints by peer id we signed last, ours included. */
  private fingerprints: Readonly<Record<string, string>> = {};
  /** The member list we signed last, and its version. */
  private signedList: SignedMemberList | null = null;
  private listVersion = 0;
  /** Invite link resets, one after the other. */
  private moving: Promise<void> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private tidyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly around: Surroundings) {
    this.doc = around.doc;
    this.mirror = around.mirror;
    this.presence = around.presence;
    this.door = around.runtime;
    this.identities = new PeerIdentities(around.link().roomId);
  }

  private get runtime(): string | null {
    return this.around.state()?.runtime ?? null;
  }

  // -------------------------------------------------------------------------
  // the room's channels

  /**
   * The room we joined, or null once we left it: the guests' answers, their
   * updates and requests come here; what we send them goes there.
   */
  attach(joined: Joined | null) {
    this.joined = joined;
    if (!joined) return;
    const { channels } = joined;

    // A guest's answer to the nonce in our hello: who it is, and so whether it is in.
    channels.identify.onMessage = async (message, { peerId }) => {
      if (this.admissions.isDropped(peerId)) return;
      const proof = message as unknown as Identify;
      const identities = this.identities;
      const identity = await identities.prove(peerId, proof);
      if (identities !== this.identities) return;
      if (!identity) {
        this.around.record({
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

    // A state vector asks for everything the sender is missing.
    channels.sync.onMessage = (vector, { peerId }) => {
      if (!this.admissions.access(peerId)) return;
      void channels.update.send(Y.encodeStateAsUpdate(this.doc, new Uint8Array(vector)), {
        target: peerId,
      });
      void this.sendSnapshot(peerId);
    };

    channels.update.onMessage = (update, { peerId }) => {
      if (!mayEdit(this.admissions.access(peerId))) return;
      Y.applyUpdate(this.doc, new Uint8Array(update), { peer: peerId });
    };

    channels.request.onRequest = async (request, { peerId }) => {
      const message = request as unknown as GuestRequest | GuestRead;
      return json(
        message.t === "session-open"
          ? this.onGuestRead(peerId, message)
          : await this.onGuestRequest(peerId, message),
      );
    };
  }

  /** Prove who we are to a new peer, and ask it who it is. */
  async arrive(peerId: string) {
    const joined = this.joined;
    if (!joined || !this.hostPrivateKey) return;
    if (!this.around.state() || this.admissions.isDropped(peerId)) return;
    const nonce = this.identities.challenge(peerId);
    const signature = await signHost(
      this.hostPrivateKey,
      this.around.link().roomId,
      this.around.selfId,
    );
    if (this.joined !== joined) return;
    await joined.channels.hello.send(json({ signature, nonce } satisfies Hello), {
      target: peerId,
    });
  }

  /** A peer left (its presence is gone already). */
  leave(peerId: string) {
    this.identities.forget(peerId);
    this.admissions.leave(peerId);
    this.publishMembers();
    this.refreshKnocks();
  }

  /** The peers that are in: everything we send goes to them only. */
  admitted(): string[] {
    return this.admissions.admitted();
  }

  /** Whether a peer is in: only theirs is taken, presence too. */
  isIn(peerId: string): boolean {
    return !!this.admissions.access(peerId);
  }

  /** To every peer that is in (whose access `to` takes, if given), and nobody else. */
  hostcast(message: HostBroadcast, to: (access: GuestAccess) => boolean = () => true) {
    const targets = this.admissions.admitted().filter((id) => to(this.admissions.access(id)!));
    if (targets.length)
      void this.joined?.channels.broadcast.send(json(message), { target: targets });
  }

  // -------------------------------------------------------------------------
  // the board

  /** `canvas serve` welcomed us: our host key, and the board's relay as it set it up for us. */
  welcome(hostPrivateKey: JsonWebKey, relay: WelcomeRelay | null) {
    this.hostPrivateKey = hostPrivateKey;
    this.relay = relay;
  }

  /** The board as `canvas serve` saved it (base64), if any. Boards from before the tree are migrated. */
  load(board: string | null | undefined) {
    if (board)
      Y.applyUpdate(
        this.doc,
        Uint8Array.from(atob(board), (c) => c.charCodeAt(0)),
        "server",
      );
    tidy(this.doc, { screen: this.around.screen() });
  }

  /** The doc changed: send it on to everyone in but the guest it came from, save, tidy. */
  onUpdate(update: Uint8Array, origin: unknown) {
    const from =
      typeof origin === "object" && origin !== null && "peer" in origin
        ? (origin.peer as string)
        : null;
    const targets = this.admissions.admitted().filter((id) => id !== from);
    if (targets.length) void this.joined?.channels.update.send(update, { target: targets });
    if (origin !== "server") this.scheduleSave();
    this.scheduleTidy();
  }

  /** Every guest that is in, up to date again (`canvas serve` welcomed us anew). */
  resync() {
    for (const peerId of this.admissions.admitted()) void this.sendSnapshot(peerId);
  }

  /**
   * Keep the board's tree tidy (`tidy`) a moment after it changes — only the
   * tab `canvas serve` talks to, so two tabs never both do.
   */
  private scheduleTidy() {
    if (this.tidyTimer) clearTimeout(this.tidyTimer);
    this.tidyTimer = setTimeout(() => {
      if (this.door.open) tidy(this.doc, { screen: this.around.screen() });
    }, 200);
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const state = Y.encodeStateAsUpdate(this.doc);
      let binary = "";
      for (const byte of state) binary += String.fromCharCode(byte);
      this.door.send({ t: "board-save", state: btoa(binary) });
    }, 800);
  }

  /**
   * Bring a guest up to date (`Mirror.snapshot`), then the member list, one
   * message at a time, as messages sent together share the channel and all
   * arrive late.
   */
  private async sendSnapshot(peerId: string) {
    const joined = this.joined;
    const access = this.admissions.access(peerId);
    if (!joined || !access) return;
    // The sessions frames show here are the board's own runtime's: keyed by their bare ids.
    const shown = shownSessions(here(this.doc, this.runtime));
    // All taken now: what changes from here on reaches the guest live.
    const messages: HostBroadcast[] = [
      ...this.mirror.snapshot(shown, access !== "view"),
      ...(this.signedList ? [{ t: "member-list" as const, ...this.signedList }] : []),
    ];
    try {
      for (const message of messages) {
        // It may be cut off meanwhile.
        if (!this.admissions.access(peerId)) return;
        await joined.channels.broadcast.send(json(message), { target: peerId });
      }
    } catch {
      // The guest left; it gets a new snapshot when it is back.
    }
  }

  // -------------------------------------------------------------------------
  // members and admission (`admission.ts`, `member-list.ts`)

  /** `canvas serve`'s member list, and what it changes for who is connected. */
  setMembers(members: ReadonlyArray<Member>) {
    this.members = members;
    this.run(this.admissions.setMembers(members));
    this.refreshTrusted();
  }

  /** Let a knocking peer in, as a member with `role`; `canvas serve` saves it. */
  admit(peerId: string, role: MemberRole) {
    const knock = this.admissions.knock(peerId);
    if (!knock || !this.door.open) return;
    this.door.send({ t: "member-admit", publicKey: knock.publicKey, name: knock.name, role });
  }

  /** Turn a knocking peer away. */
  deny(peerId: string) {
    if (!this.admissions.deny(peerId)) return;
    this.tell(peerId, { t: "denied" });
    this.refreshKnocks();
  }

  /** What a member may do from now on. */
  setRole(fingerprint: string, role: MemberRole) {
    this.door.send({ t: "member-role", fingerprint, role });
  }

  /**
   * Trust a member, or take it back: runs without the approval click,
   * typing into terminals. Never saved; it lasts while this tab is the host.
   */
  trust(fingerprint: string, on: boolean) {
    this.run(this.admissions.trust(fingerprint, on));
    this.refreshTrusted();
  }

  /**
   * A member is out, at once; coming again is knocking again. `canvas serve`
   * resets the invite link too: the link they hold leads nowhere.
   */
  removeMember(fingerprint: string) {
    this.door.send({ t: "member-remove", fingerprint });
  }

  /** A new invite link (decision 6). Members here move along; links from before lead nowhere. */
  resetInviteLink() {
    this.door.send({ t: "room-reset" });
  }

  /** The key `peerId` proved it holds, if it has. */
  verifiedPeer(peerId: string): PeerIdentity | undefined {
    return this.identities.get(peerId);
  }

  /** Do what a change in who is in asks for. */
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
            for (const tree of this.mirror.treeMessages())
              void this.joined?.channels.broadcast.send(json(tree), { target: step.peerId });
          break;
        case "knock":
          this.around.record({
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
    void this.joined?.channels.admission.send(json(message), { target: peerId });
  }

  /** A peer is in. It syncs against our vector; then it gets the rest. */
  private letIn(peerId: string, access: GuestAccess) {
    const state = this.around.state();
    if (!state) return;
    this.tell(peerId, {
      t: "admitted",
      access,
      state,
      vector: [...Y.encodeStateVector(this.doc)],
    });
    this.presence.send(peerId);
  }

  /** A peer is out: its presence goes, and so do its requests waiting for us. */
  private shutOut(peerId: string) {
    this.presence.drop(peerId);
    for (const approval of this.approvals.filter((a) => a.peerId === peerId))
      approval.resolve(false);
  }

  private refreshKnocks() {
    this.knocks = this.admissions.knocks();
    this.around.emit("members");
  }

  private refreshTrusted() {
    this.trusted = this.members.flatMap((m) =>
      this.admissions.isTrusted(m.fingerprint) ? [m.fingerprint] : [],
    );
    this.around.emit("members");
  }

  /** Sign who is in — their peer ids and the fingerprints we verified, ours included — and tell them. */
  private publishMembers() {
    const members = {
      ...this.admissions.fingerprints(),
      [this.around.selfId]: this.around.fingerprint,
    };
    // A knock or a role changes nobody's place on it.
    if (JSON.stringify(members) === JSON.stringify(this.fingerprints)) return;
    this.showFingerprints(members);
    const key = this.hostPrivateKey;
    if (!key) return;
    this.listVersion = nextVersion(this.listVersion);
    const list = {
      host: this.around.selfId,
      version: this.listVersion,
      members: this.fingerprints,
    };
    void signMembers(key, this.around.link().roomId, list).then((signed) => {
      // Signing takes a moment: a later list may have gone out meanwhile.
      if (list.version !== this.listVersion || !this.joined) return;
      this.signedList = signed;
      this.hostcast({ t: "member-list", ...signed });
    });
  }

  private showFingerprints(fingerprints: Readonly<Record<string, string>>) {
    this.fingerprints = fingerprints;
    this.presence.showFingerprints(fingerprints);
  }

  // -------------------------------------------------------------------------
  // handover (`handover.ts`)

  /** The relay we join with, with the host's token; null for a board without one. */
  ownRelay(): RelayLink | null {
    return this.relay && { ...this.relay, token: this.relay.hostToken };
  }

  /** The relay guest links name, with the guest token; null for a board without one. */
  guestRelay(): RelayLink | null {
    const setup = this.relay;
    return setup && { url: setup.url, via: setup.via, token: setup.guestToken };
  }

  /** `canvas serve` minted a new room (`room-reset`, `member-remove`): we move there, after the members. */
  reset(room: RoomSecrets, relay: WelcomeRelay | null) {
    this.moving = this.moving
      .then(() => this.move(room, relay))
      .catch((error: unknown) =>
        this.around.record({
          level: "error",
          source: "serve",
          text: `resetting the invite link: ${error}`,
        }),
      );
  }

  /**
   * Each member that is in gets the new room, sealed to its own seal key;
   * once they left for it, or a moment passed, we follow. Nobody else is told.
   */
  private async move(secrets: RoomSecrets, relay: WelcomeRelay | null) {
    const from = this.around.link();
    const next: BoardLink = { ...from, roomId: secrets.roomId, key: secrets.key };
    this.next = next;
    this.relay = relay;
    this.around.emit("room");
    const { joined, hostPrivateKey } = this;
    if (joined && hostPrivateKey) {
      const move: Move = { roomId: next.roomId, key: next.key, relay: this.guestRelay() };
      const moving = this.admissions.moving();
      this.around.record({
        level: "info",
        source: "relay",
        text: `the invite link was reset: ${moving.length} member${moving.length === 1 ? "" : "s"} move along`,
      });
      await Promise.allSettled(
        moving.map(async ({ peerId, sealKey }) => {
          const sealed = await sealMove(hostPrivateKey, from.roomId, peerId, sealKey, move);
          await joined.channels.admission.send(
            json({ t: "moved", ...sealed } satisfies Admission),
            { target: peerId },
          );
        }),
      );
      // Leaving closes the channels: what we sent must arrive first.
      const end = Date.now() + MOVE_WAIT_MS;
      while (Date.now() < end && moving.some(({ peerId }) => joined.peers().includes(peerId)))
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.around.relocate(next);
  }

  /** We are in the room `next` names now (the participant moved): who is in comes again. */
  relocated(next: BoardLink) {
    this.next = null;
    this.identities = new PeerIdentities(next.roomId);
    this.fingerprints = {};
    this.admissions.moved();
    this.signedList = null;
    for (const approval of [...this.approvals]) approval.resolve(false);
    this.refreshKnocks();
  }

  /** Another tab is the host (we left the room): nobody is in here any more. */
  stepDown() {
    this.around.record({
      level: "info",
      source: "relay",
      text: "left the room: another tab is the host",
    });
    this.identities.clear();
    this.admissions.clear();
    this.refreshKnocks();
    this.refreshTrusted();
    this.showFingerprints({});
    this.signedList = null;
    for (const approval of [...this.approvals]) approval.resolve(false);
  }

  // -------------------------------------------------------------------------
  // requests

  /**
   * Run a request on the board's own runtime (ADR 0013, decision 7): another's
   * isn't reachable from here.
   */
  execute(request: GuestRequest, author: Identity) {
    const runtime = this.runtime;
    if (reach(request, runtime) !== "own") throw new Error(NOT_REACHABLE);
    if (!this.door.open) throw new Error("not connected to canvas serve");
    switch (request.t) {
      case "agent-prompt": {
        const { sessionId, frameId, text } = request;
        const frame = promptFrame(allFrames(this.doc), frameId, sessionId);
        if (frameReach(frame, runtime) !== "own") throw new Error(NOT_REACHABLE);
        const session = this.mirror.session(sessionId);
        if (session && session.meta.status !== "idle") throw new Error("the agent is still busy");
        // The first prompt begins the session (ADR 0012, decision 4), as the frame says.
        const start = startIn(frame, !!session);
        this.door.send({ t: "agent-prompt", sessionId, ...start, text, author });
        return;
      }
      case "agent-cancel":
        this.door.send({ t: "agent-cancel", sessionId: request.sessionId });
        return;
      case "agent-config": {
        const { sessionId, configId, value } = request;
        // Not begun yet: the change begins it, as the frame showing it says.
        const frame = framesShowing(here(this.doc, runtime), sessionId)[0];
        const start = frame && !this.mirror.session(sessionId) ? startIn(frame, false) : undefined;
        this.door.send({
          t: "agent-config",
          sessionId,
          configId,
          value,
          ...(start && { start }),
        });
        return;
      }
      case "term-input":
        this.door.send({ t: "term-input", pty: request.pty, data: request.data });
        return;
    }
  }

  private async onGuestRequest(peerId: string, request: GuestRequest): Promise<GuestReply> {
    const peer = this.presence.nameOf(peerId);
    try {
      // Not for the host to approve: it can't reach it.
      if (reach(request, this.runtime) !== "own") throw new Error(NOT_REACHABLE);
      const verdict = check(this.admissions.access(peerId), request);
      if (!verdict.ok) throw new Error(verdict.error);
      if (verdict.approve && !(await this.ask(peerId, peer, request)))
        throw new Error(`${this.around.identity.name} declined`);
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
   * A guest reads what the board shows anyway — any member that is in, `view`
   * too; nothing for the lobby (ADR 0011). A session's log goes to it now, or
   * with everyone's once `canvas serve` sends it to us.
   */
  private onGuestRead(peerId: string, read: GuestRead): GuestReply {
    if (!this.admissions.access(peerId)) return { ok: false, error: "the host hasn't let you in" };
    const session = this.mirror.session(read.sessionId, read);
    if (!session) return { ok: false, error: "no such conversation" };
    if (!session.pending) {
      const history: HostBroadcast = {
        t: "session-history",
        ...session.at,
        sessionId: read.sessionId,
        events: session.events.slice(),
      };
      void this.joined?.channels.broadcast.send(json(history), { target: peerId });
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
          this.around.emit("approvals");
          resolve(approved);
        },
      };
      this.approvals = [...this.approvals, approval];
      this.around.emit("approvals");
    });
  }
}
