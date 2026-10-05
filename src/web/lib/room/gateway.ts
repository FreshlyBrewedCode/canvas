/**
 * The host's way to its machine (ADR 0013, decision 2): the paired link to
 * `canvas serve` (`server-link.ts`, ADR 0011 decision 3). What `canvas serve`
 * sends goes into the mirror (`mirror.ts`) and on to the guests; what the
 * board shows is kept open there (`sync`): files, the tree, terminals,
 * sessions' logs, and an agent no frame shows any more is released (ADR
 * 0012). Agents' board tool calls run here, against the doc (ADR 0003).
 *
 * Only `canvas serve`'s runtime, the board's own, is reached (ADR 0013,
 * decision 7): its things are keyed by bare id (`addressKey`), and named to
 * it without an address.
 */

import type * as Y from "yjs";

import { reach, type UncheckedAddress } from "../../../shared/address";
import { ownerStatement } from "../../../shared/identity";
import type {
  ClientToServer,
  HostBroadcast,
  GuestAccess,
  Member,
  RoomSecrets,
  RoomState,
  ServerToClient,
  ToolImage,
  WelcomeRelay,
} from "../../../shared/protocol";
import { shownPty, shownSession } from "../board";
import { runBoardTool } from "../board-tools";
import type { ConnectionEvent } from "../connection";
import { drawingImage, prepareDrawCall } from "../drawing-kit";
import type { BrowserKey } from "../identity-key";
import { forgetPairingCode, type BoardLink } from "../link";
import { Releases, shownSessions } from "../sessions";
import { ServerLink, type LinkStatus } from "../server-link";
import type { RuntimeDoor } from "./authority";
import type { Mirror } from "./mirror";
import { agentFrame, here, runtimeOf } from "./reach";
import type { Topic } from "./topics";

export type Welcome = Extract<ServerToClient, { t: "welcome" }>;

/** What `canvas serve` says that is for the rest of the room. */
export interface GatewayEvents {
  welcome(message: Welcome): void;
  members(members: ReadonlyArray<Member>): void;
  /** A new room (the invite link was reset). */
  room(room: RoomSecrets, relay: WelcomeRelay | null): void;
  /** For the guests that are in (whose access `to` takes, if given). */
  forward(message: HostBroadcast, to?: (access: GuestAccess) => boolean): void;
  /** An agent works on `frameId` now, acting as `agentFrame` (its turn's). */
  claim(sessionId: string, agentFrame: string, frameId: string): void;
  /** An agent's turn is over: it leaves the frame it worked on. */
  idle(sessionId: string): void;
  /** Another tab took over `canvas serve`. */
  replaced(): void;
  record(event: Omit<ConnectionEvent, "at">): void;
  emit(topic: Topic): void;
}

export interface GatewayOptions {
  readonly doc: Y.Doc;
  readonly mirror: Mirror;
  /** The room as the welcome said; null until then. */
  readonly state: () => RoomState | null;
  readonly events: GatewayEvents;
}

export class Gateway implements RuntimeDoor {
  /** The link's status, once it said. */
  status: LinkStatus | null = null;

  private readonly server: ServerLink;
  private readonly doc: Y.Doc;
  private readonly mirror: Mirror;
  private readonly events: GatewayEvents;
  /** Which sessions' agents may stop, as frames stop showing them (ADR 0012). */
  private readonly releases = new Releases();
  /** Paths opened with the server since the link came up. */
  private readonly watched = new Set<string>();
  private treeWatched = false;
  /**
   * Terminals opened, session logs asked for (`log:<id>`) and kinds probed
   * (`kind:<agent>`) since the server link came up.
   */
  private readonly opened = new Set<string>();

  constructor(
    link: BoardLink,
    key: BrowserKey,
    private readonly options: GatewayOptions,
  ) {
    this.doc = options.doc;
    this.mirror = options.mirror;
    this.events = options.events;
    const host = link.host!;
    // The link's pairing code goes along until the server welcomes us once: then we are an owner.
    let pair = host.pair;
    this.server = new ServerLink(
      `${host.server}/ws`,
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
        if (status !== this.status && status !== "connecting")
          this.events.record({
            level: status === "open" ? "info" : status === "refused" ? "error" : "warn",
            source: "serve",
            text:
              status === "refused"
                ? `canvas serve refused this browser: ${this.refusal}`
                : `canvas serve: ${status}`,
          });
        this.status = status;
        if (status === "replaced") this.events.replaced();
        if (status !== "open") {
          this.watched.clear();
          this.treeWatched = false;
          this.opened.clear();
        }
        this.events.emit("room");
      },
    );
  }

  private get runtime(): string | null {
    return this.options.state()?.runtime ?? null;
  }

  get open(): boolean {
    return this.server.status === "open";
  }

  /** Dropped while the link isn't open. */
  send(message: ClientToServer) {
    this.server.send(message);
  }

  /** Why `canvas serve` refused this browser, if it did. */
  get refusal(): string | null {
    return this.server.refusal ?? null;
  }

  /** Be the host again after another tab took over (it steps down in turn). */
  takeOver() {
    this.server.takeOver();
  }

  close() {
    this.server.close();
  }

  /** Answer a tool-call permission the agent asked for (the host's own only). */
  answerPermission(
    sessionId: string,
    requestId: string,
    optionId: string | null,
    by: string,
    at: UncheckedAddress = {},
  ) {
    if (reach(at, this.runtime) !== "own") return;
    this.server.send({ t: "agent-permission", sessionId, requestId, optionId, by });
  }

  /** A terminal follows the host's frame size. */
  resizeTerminal(pty: string, cols: number, rows: number, at: UncheckedAddress = {}) {
    if (reach(at, this.runtime) !== "own") return;
    this.server.send({ t: "term-resize", pty, cols, rows });
  }

  private onServer(message: ServerToClient) {
    const { mirror, events } = this;
    switch (message.t) {
      case "welcome":
        return events.welcome(message);
      case "members":
        return events.members(message.members);
      case "room":
        return events.room(message.room, message.relay);
      // What `canvas serve` sends names what it is about as it was asked
      // (ADR 0013, decision 7), and goes on to guests so.
      case "agent-meta":
        mirror.putMeta(message, message.meta);
        if (reach(message, this.runtime) === "own") {
          // Its turn is over: it leaves the frame it worked on.
          if (message.meta.status === "idle") events.idle(message.meta.id);
          // No frame shows it since it ran: its agent stops now.
          if (this.releases.settle(message.meta.id, message.meta.status))
            this.server.send({ t: "agent-release", sessionId: message.meta.id });
        }
        return events.forward(message);
      case "agent-event": {
        // Guests get a session's events once we have its log, after it.
        const { sessionId, event } = message;
        if (mirror.pushEvent(message, sessionId, event)) {
          const index = mirror.session(sessionId, message)!.events.length - 1;
          const at = runtimeOf(message, this.runtime);
          events.forward({ t: "agent-event", ...at, sessionId, event, index });
        }
        return;
      }
      case "agent-options":
        mirror.putOptions(message, message.sessionId, message.options);
        return events.forward(message);
      case "session-history":
        mirror.putHistory(message, message.sessionId, message.events);
        return events.forward(message);
      case "kind-options":
        mirror.putKind(message, message.agent, message.options);
        return events.forward(message);
      case "term-data":
        mirror.pushTerm(message, message.pty, message.data);
        return events.forward(message);
      case "term-exit": {
        const data = `\r\n\x1b[2m[process exited${message.code === null ? "" : ` with ${message.code}`}]\x1b[0m\r\n`;
        const { pty } = message;
        mirror.pushTerm(message, pty, data);
        this.opened.delete(mirror.keyOf(message, pty));
        return events.forward({ t: "term-data", ...runtimeOf(message, this.runtime), pty, data });
      }
      case "file":
        mirror.putFile(message, message.path, message.file);
        return events.forward(message);
      case "tree":
        mirror.putTree(message, message.paths);
        return events.forward(message, (access) => access !== "view");
      case "board-call":
        return void this.runBoardCall(message);
      case "error":
        return events.record({ level: "error", source: "serve", text: message.message });
    }
  }

  /**
   * Make sure exactly the files the board shows are open and every terminal
   * is running; get the logs of the sessions agent frames show, and what a
   * kind of agent offers where a frame's session hasn't begun (ADR 0012). A
   * session no frame shows any more is released: its agent stops. Only
   * frames on `canvas serve`'s runtime (`here`).
   */
  sync() {
    if (this.server.status !== "open") return;
    const frames = here(this.doc, this.runtime);
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
        const session = this.mirror.session(sessionId);
        if (session?.pending && !this.opened.has(`log:${sessionId}`)) {
          this.opened.add(`log:${sessionId}`);
          this.server.send({ t: "session-open", sessionId });
        }
        // Settings to show before its agent runs: what the kind offers.
        const unknown = !session?.options && !this.mirror.kindOptions(frame.agent);
        if (unknown && !this.opened.has(`kind:${frame.agent}`)) {
          this.opened.add(`kind:${frame.agent}`);
          this.server.send({ t: "kind-probe", agent: frame.agent });
        }
      }
      const pty = frame.type === "terminal" ? shownPty(frame) : null;
      if (pty && !this.opened.has(pty)) {
        this.opened.add(pty);
        this.mirror.restartTerminal(pty);
        this.server.send({ t: "term-open", pty, cols: 80, rows: 24 });
      }
    }
    const shown = shownSessions(frames);
    const status = (id: string) => this.mirror.session(id)?.meta.status;
    for (const sessionId of this.releases.show(shown, status))
      this.server.send({ t: "agent-release", sessionId });
  }

  /**
   * Run an agent's board tool call against the board, and answer it. A
   * drawing's elements are made before, and its image after (ADR 0009).
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
          agents: this.options.state()?.agents ?? [],
          status: (frameId) => this.statusOf(frameId),
        },
        message.tool,
        args,
      );
      text = result.text;
      if (result.image) images = [await drawingImage(this.doc, result.image)];
      if (result.frame) this.events.claim(message.sessionId, message.frameId, result.frame);
    } catch (error) {
      ok = false;
      text = error instanceof Error ? error.message : String(error);
    }
    this.server.send({ t: "board-result", callId: message.callId, ok, text, images });
  }

  /** The status of the session an agent frame shows, if it has begun. */
  private statusOf(frameId: string) {
    const frame = agentFrame(this.doc, frameId);
    return frame && this.mirror.session(shownSession(frame), frame)?.meta.status;
  }
}
