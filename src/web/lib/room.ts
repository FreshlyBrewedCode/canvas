/**
 * One board session in the browser: the Yjs doc, presence, the trystero room
 * and — for the host — the link to `canvas serve`.
 *
 * Topology. Presence (cursors, selections) is a full mesh: every peer
 * broadcasts to every other. Everything with authority is a star around the
 * host's browser:
 *
 *  - board updates: guests send theirs to the host only; the host applies
 *    what the guest's access allows and re-broadcasts. A read-only guest's
 *    edits therefore never reach anyone.
 *  - agent threads and terminals: only the host has them (from the server);
 *    it mirrors them to guests.
 *  - anything that runs on the host's machine is a request to the host,
 *    checked against the room's access policy, possibly waiting for the host
 *    to approve it.
 *
 * Guests only accept host traffic from the peer that proved it holds the
 * board's host key (see `host-key.ts`).
 */

import { joinRoom, selfId, type Room as TrysteroRoom } from "trystero";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type {
  AgentEvent,
  GuestAccess,
  GuestReply,
  GuestRequest,
  HostBroadcast,
  RoomState,
  ServerToClient,
  SessionMeta,
  SessionSnapshot,
} from "../../shared/protocol";
import { framesOf, markdownText, replaceText, type Frame } from "./board";
import { signHost, verifyHost } from "./host-key";
import type { BoardLink, Identity } from "./link";
import { ServerLink, type LinkStatus } from "./server-link";

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
  /** A text selection inside an agent thread, anchored to message keys. */
  readonly selection: ThreadSelection | null;
}

export interface ThreadSelection {
  readonly frameId: string;
  readonly anchor: { readonly key: string; readonly offset: number };
  readonly focus: { readonly key: string; readonly offset: number };
}

type Topic = "room" | "approvals" | "peers" | `session:${string}` | `term:${string}`;

const APP_ID = "canvas-prototype-v1";
const TERM_SCROLLBACK = 200_000;
const json = <T>(value: T) => value as never;

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly isHost: boolean;
  readonly selfId = selfId;

  roomState: RoomState | null = null;
  serverStatus: LinkStatus | null = null;
  hostOnline = false;
  approvals: Approval[] = [];
  /** Everyone else's presence; a new array on every change. */
  peerList: Presence[] = [];
  error: string | null = null;

  private readonly sessions = new Map<
    string,
    { meta: SessionMeta; events: AgentEvent[]; version: number }
  >();
  private readonly terminals = new Map<string, string>();
  private readonly listeners = new Map<Topic, Set<() => void>>();
  private readonly peerClients = new Map<string, Set<number>>();
  private readonly server: ServerLink | null = null;
  private hostPrivateKey: JsonWebKey | null = null;
  private trystero: TrysteroRoom | null = null;
  private actions: ReturnType<Room["makeActions"]> | null = null;
  private access: GuestAccess = "edit";
  private readonly watched = new Set<string>();
  private readonly opened = new Set<string>();
  private readonly writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly link: BoardLink,
    readonly identity: Identity,
  ) {
    this.isHost = link.host !== null;
    this.setPresence({ pointer: null, selection: null });
    this.doc.on("update", (update: Uint8Array, origin: unknown) =>
      this.onDocUpdate(update, origin),
    );
    this.awareness.on("change", () => {
      this.peerList = this.peers();
      this.emit("peers");
    });
    this.awareness.on("update", ({ added, updated, removed }: AwarenessChange, origin: unknown) =>
      this.onAwareness([...added, ...updated, ...removed], added, origin),
    );

    if (link.host) {
      const url = `${link.host.server}/ws?token=${encodeURIComponent(link.host.token)}`;
      this.server = new ServerLink(
        url,
        (message) => this.onServer(message),
        (status) => {
          this.serverStatus = status;
          if (status !== "open") {
            this.watched.clear();
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

  terminal(id: string): string {
    return this.terminals.get(id) ?? "";
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

  private onAwareness(changed: number[], added: number[], origin: unknown) {
    if (typeof origin === "string" && origin !== "local" && origin !== "leave") {
      // Remember which Yjs clients belong to which peer, to drop them on leave.
      let set = this.peerClients.get(origin);
      if (!set) this.peerClients.set(origin, (set = new Set()));
      for (const id of added) set.add(id);
      return;
    }
    if (origin === "local" && this.actions) {
      void this.actions.presence.send(encodeAwarenessUpdate(this.awareness, changed));
    }
  }

  // -------------------------------------------------------------------------
  // trystero

  private makeActions(room: TrysteroRoom) {
    return {
      hello: room.makeAction("hello"),
      state: room.makeAction("state"),
      broadcast: room.makeAction("hostcast"),
      update: room.makeAction<Uint8Array>("yupdate"),
      sync: room.makeAction<Uint8Array>("ysync"),
      presence: room.makeAction<Uint8Array>("presence"),
      request: room.makeAction("request", { kind: "request" }),
    };
  }

  private join() {
    if (this.trystero) return;
    const room = joinRoom({ appId: APP_ID, password: this.link.key }, this.link.roomId, {
      onJoinError: ({ error }) => {
        this.error = error;
        this.emit("room");
      },
    });
    this.trystero = room;
    const actions = this.makeActions(room);
    this.actions = actions;

    room.onPeerJoin = (peerId) => {
      void actions.presence.send(encodeAwarenessUpdate(this.awareness, [this.doc.clientID]), {
        target: peerId,
      });
      if (this.isHost) void this.greet(peerId);
    };
    room.onPeerLeave = (peerId) => {
      removeAwarenessStates(this.awareness, [...(this.peerClients.get(peerId) ?? [])], "leave");
      this.peerClients.delete(peerId);
      if (peerId === this.roomState?.hostPeerId && !this.isHost) {
        this.hostOnline = false;
        this.emit("room");
      }
    };

    actions.presence.onMessage = (update, { peerId }) =>
      applyAwarenessUpdate(this.awareness, new Uint8Array(update), peerId);

    // The host's hello carries everything a guest needs to start, so nothing
    // arrives while the (async) signature check is still running.
    actions.hello.onMessage = async (message, { peerId }) => {
      const { signature, state, vector } = message as unknown as Hello;
      if (this.isHost) return;
      if (!(await verifyHost(this.link.hostPublicKey, this.link.roomId, peerId, signature))) return;
      this.hostOnline = true;
      this.roomState = state;
      this.emit("room");
      void actions.update.send(Y.encodeStateAsUpdate(this.doc, Uint8Array.from(vector)), {
        target: peerId,
      });
      void actions.sync.send(Y.encodeStateVector(this.doc), { target: peerId });
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
      if (this.isHost) this.sendSnapshot(peerId);
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
    };
    await this.actions.hello.send(json(hello), { target: peerId });
  }

  private sendSnapshot(peerId: string) {
    const sessions = [...this.sessions.values()].map(({ meta, events }) => ({ meta, events }));
    void this.actions?.broadcast.send(json({ t: "sessions", sessions } satisfies HostBroadcast), {
      target: peerId,
    });
    for (const [id, data] of this.terminals) {
      void this.actions?.broadcast.send(
        json({ t: "term-data", id, data } satisfies HostBroadcast),
        { target: peerId },
      );
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
      const targets = Object.keys(this.trystero?.getPeers() ?? {}).filter((id) => id !== from);
      if (targets.length) void this.actions?.update.send(update, { target: targets });
      if (origin !== "server") this.scheduleSave();
      this.syncResources();
    } else if (origin !== "host" && this.hostOnline && this.roomState) {
      void this.actions?.update.send(update, { target: this.roomState.hostPeerId });
    }
  }

  private applyBroadcast(message: HostBroadcast) {
    switch (message.t) {
      case "sessions":
        this.sessions.clear();
        for (const snapshot of message.sessions) this.putSession(snapshot);
        return;
      case "agent-meta":
        return this.putMeta(message.meta);
      case "agent-event":
        return this.pushEvent(message.sessionId, message.event);
      case "term-data":
        return this.pushTerm(message.id, message.data);
    }
  }

  // -------------------------------------------------------------------------
  // sessions & terminals (local mirror)

  private putSession(snapshot: SessionSnapshot) {
    this.sessions.set(snapshot.meta.id, {
      meta: snapshot.meta,
      events: [...snapshot.events],
      version: Date.now(),
    });
    this.emit(`session:${snapshot.meta.id}`);
  }

  private putMeta(meta: SessionMeta) {
    const session = this.sessions.get(meta.id);
    if (session) {
      session.meta = meta;
      session.version++;
    } else this.sessions.set(meta.id, { meta, events: [], version: 0 });
    this.emit(`session:${meta.id}`);
  }

  private pushEvent(sessionId: string, event: AgentEvent) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.events.push(event);
    session.version++;
    this.emit(`session:${sessionId}`);
  }

  private pushTerm(id: string, data: string) {
    this.terminals.set(id, (this.terminal(id) + data).slice(-TERM_SCROLLBACK));
    this.emit(`term:${id}`);
  }

  // -------------------------------------------------------------------------
  // host ⇄ server

  private onServer(message: ServerToClient) {
    switch (message.t) {
      case "welcome": {
        this.hostPrivateKey = message.room.hostPrivateKey;
        if (message.board)
          Y.applyUpdate(
            this.doc,
            Uint8Array.from(atob(message.board), (c) => c.charCodeAt(0)),
            "server",
          );
        this.sessions.clear();
        for (const snapshot of message.sessions) this.putSession(snapshot);
        this.roomState = {
          hostPeerId: selfId,
          access: this.access,
          cwd: message.cwd,
          agents: message.agents,
        };
        this.hostOnline = true;
        this.emit("room");
        this.join();
        this.syncResources();
        for (const peerId of Object.keys(this.trystero?.getPeers() ?? {}))
          this.sendSnapshot(peerId);
        return;
      }
      case "agent-meta":
        this.putMeta(message.meta);
        return this.hostcast(message);
      case "agent-event":
        this.pushEvent(message.sessionId, message.event);
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
        return this.onFile(message.path, message.content);
      case "error":
        this.error = message.message;
        return this.emit("room");
    }
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
    const frames: Frame[] = [];
    framesOf(this.doc).forEach((map, id) => frames.push({ ...(map.toJSON() as Frame), id }));
    return frames;
  }

  /** Host: make sure every markdown frame is watched and every terminal is running. */
  private syncResources() {
    if (!this.isHost || this.server?.status !== "open") return;
    for (const frame of this.frames()) {
      if (
        frame.type === "markdown" &&
        frame.path &&
        !this.watched.has(`${frame.id}:${frame.path}`)
      ) {
        this.watched.add(`${frame.id}:${frame.path}`);
        this.observeMarkdown(frame.id);
        this.server.send({ t: "file-watch", path: frame.path });
      }
      if (frame.type === "terminal" && !this.opened.has(frame.id)) {
        this.opened.add(frame.id);
        this.terminals.delete(frame.id);
        this.server.send({ t: "term-open", id: frame.id, cols: 80, rows: 24 });
      }
    }
  }

  private readonly observedMarkdown = new Set<string>();

  /** Host: write collaborative edits of a markdown frame back to its file. */
  private observeMarkdown(frameId: string) {
    if (this.observedMarkdown.has(frameId)) return;
    this.observedMarkdown.add(frameId);
    markdownText(this.doc, frameId).observe((_, transaction) => {
      if (transaction.origin === "disk") return;
      clearTimeout(this.writeTimers.get(frameId));
      this.writeTimers.set(
        frameId,
        setTimeout(() => {
          const frame = this.frames().find((f) => f.id === frameId);
          if (frame?.type !== "markdown") return;
          this.server?.send({
            t: "file-write",
            path: frame.path,
            content: markdownText(this.doc, frameId).toString(),
          });
        }, 400),
      );
    });
  }

  private onFile(path: string, content: string | null) {
    for (const frame of this.frames()) {
      if (frame.type !== "markdown" || frame.path !== path) continue;
      const text = markdownText(this.doc, frame.id);
      if (content === null) {
        // A new artifact: create the file from whatever the board has.
        this.server?.send({
          t: "file-write",
          path,
          content: text.length ? text.toString() : `# ${frame.title}\n`,
        });
      } else replaceText(text, content, "disk");
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
    this.access = access;
    this.roomState = { ...this.roomState, access };
    void this.actions?.state.send(json(this.roomState));
    this.emit("room");
  }

  private peers(): Presence[] {
    return [...this.awareness.getStates().entries()]
      .filter(([id]) => id !== this.doc.clientID)
      .map(([, state]) => state as Presence)
      .filter((state) => state.user);
  }

  destroy() {
    this.server?.close();
    void this.trystero?.leave();
    this.awareness.destroy();
  }
}

interface Hello {
  readonly signature: string;
  readonly state: RoomState;
  readonly vector: number[];
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}
