/**
 * The two wire contracts of canvas, shared by the CLI server and the web app.
 *
 *   guest browser ──trystero──▶ host browser ──WebSocket──▶ `canvas serve`
 *
 * Only the host's browser talks to the server (a browser paired with it, ADR
 * 0011). Guests talk to the host over trystero and never reach the machine
 * directly: every action that would touch it is a request the host's browser
 * checks against the requesting member's role before relaying.
 */

// ---------------------------------------------------------------------------
// Agent sessions

export type AgentKind = string;

export interface AgentInfo {
  readonly kind: AgentKind;
  readonly label: string;
}

export interface Author {
  readonly name: string;
  readonly color: string;
}

export type SessionStatus = "idle" | "running" | "waiting";

export interface SessionMeta {
  readonly id: string;
  readonly agent: AgentKind;
  readonly status: SessionStatus;
  /** The agent's own session id, used to resume the conversation next turn. */
  readonly acpSessionId?: string;
  /**
   * The agent's settings as it last reported them. Small enough to persist:
   * shown while the agent is not connected, and re-applied when it reconnects.
   */
  readonly settings?: ReadonlyArray<AgentSetting>;
  /** How full the agent's context is, as it last said (ACP `usage_update`); not every agent does. */
  readonly usage?: ContextUsage;
}

export interface ContextUsage {
  /** Tokens in the context now. */
  readonly used: number;
  /** The context window, in tokens. */
  readonly size: number;
  /** The session's cost so far, if the agent knows it. */
  readonly cost?: { readonly amount: number; readonly currency: string };
}

export type AgentConfigValue = string | boolean;

/**
 * One setting an agent offers for its session (an ACP session config option):
 * model, reasoning effort, mode, … The agent decides which exist — they can
 * change with the model — so clients render whatever arrives.
 */
export interface AgentConfigOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** ACP category, for placement only: `model`, `thought_level`, `model_config`, `mode`, … */
  readonly category?: string;
  readonly type: "select" | "boolean";
  readonly value: AgentConfigValue;
  /** The values of a `select` (empty for `boolean`). */
  readonly choices: ReadonlyArray<AgentConfigChoice>;
}

export interface AgentConfigChoice {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
  /** The agent's group heading, if it groups its values. */
  readonly group?: string;
}

/** An option's current value, without the list of choices. */
export interface AgentSetting {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly value: AgentConfigValue;
  /** Display name of `value`. */
  readonly label: string;
}

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  /** ACP option kind: `allow_once`, `allow_always`, `reject_once`, `reject_always`. */
  readonly kind: string;
}

/**
 * One entry of a session's append-only log. `chunk` carries an AG-UI chunk
 * verbatim; every client folds the log with the same reducer, so the host and
 * all guests render an identical thread.
 */
export type AgentEvent =
  | {
      readonly kind: "turn";
      readonly turnId: string;
      readonly text: string;
      readonly author: Author;
      readonly at: number;
    }
  | { readonly kind: "chunk"; readonly turnId: string; readonly chunk: unknown }
  | {
      readonly kind: "permission";
      readonly turnId: string;
      readonly requestId: string;
      /** The tool call this permission gates, when the agent says. */
      readonly toolCallId?: string;
      readonly title: string;
      readonly options: ReadonlyArray<PermissionOption>;
    }
  | {
      readonly kind: "permission-resolved";
      readonly requestId: string;
      readonly optionId: string | null;
      readonly by: string;
    }
  | {
      readonly kind: "turn-end";
      readonly turnId: string;
      /** When it ended (absent in logs from before it was kept). */
      readonly at?: number;
      readonly error?: string;
      readonly cancelled?: boolean;
    };

/**
 * The name of the AG-UI `CUSTOM` chunk that carries the agent's plan (an ACP
 * `plan` update): `{ entries: PlanEntry[] }`, the whole plan each time.
 */
export const PLAN_EVENT = "plan";

export interface PlanEntry {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
  readonly priority?: "high" | "medium" | "low";
}

export interface SessionSnapshot {
  readonly meta: SessionMeta;
  readonly events: ReadonlyArray<AgentEvent>;
  /** The settings with their choices; absent until the agent has connected. */
  readonly options?: ReadonlyArray<AgentConfigOption>;
}

/** A session without its event log: what a guest sees before the history arrives. */
export type SessionHead = Omit<SessionSnapshot, "events">;

// ---------------------------------------------------------------------------
// Files

/**
 * A file of the working dir as the server lets it out: only paths in the
 * shared set (ADR 0002), read-only, text only.
 */
export type FileContent =
  | { readonly kind: "text"; readonly text: string }
  /** Shared, but not there (yet) — an agent may be about to write it. */
  | { readonly kind: "missing" }
  | { readonly kind: "binary"; readonly size: number }
  | { readonly kind: "too-large"; readonly size: number }
  | { readonly kind: "denied"; readonly reason: string };

// ---------------------------------------------------------------------------
// Host browser ⇄ server (JSON over one WebSocket)

export interface RoomSecrets {
  readonly roomId: string;
  /** trystero room password — peers without it cannot even decrypt signalling. */
  readonly key: string;
  /** ECDSA P-256 public key (base64url raw point); guests verify the host with it. */
  readonly hostPublicKey: string;
  /** The matching private key (JWK) — only ever sent to the host's browser. */
  readonly hostPrivateKey: JsonWebKey;
}

/** How a board uses its `canvas relay` (ADR 0008): for everything, or only to meet. */
export type RelayVia = "transport" | "signal";

/** What the host's browser needs for the board's relay, signed fresh for each host tab. */
export interface WelcomeRelay {
  readonly url: string;
  readonly via: RelayVia;
  /** The host tab's own token. */
  readonly hostToken: string;
  /** The token guest links carry. */
  readonly guestToken: string;
}

/**
 * Close code of a host browser's WebSocket when another one connected: one
 * host tab at a time, and the replaced one must not reconnect by itself, or
 * two tabs would take the connection from each other forever.
 */
export const HOST_REPLACED = 4001;

/**
 * Close code of a socket that didn't authenticate as an owner (ADR 0011,
 * decision 3); the reason says why. Retrying can't help.
 */
export const AUTH_REFUSED = 4003;

/**
 * Every socket's first message, and the only one `canvas serve` takes before
 * it: the answer to `challenge`. `signature` is over `ownerStatement` (`shared/identity.ts`)
 * with this browser's key; `pair` a pairing code, which makes the key an owner.
 */
export interface AuthMessage {
  readonly t: "auth";
  readonly publicKey: string;
  readonly signature: string;
  readonly pair?: string;
}

export type ClientToServer =
  | AuthMessage
  | { readonly t: "board-save"; readonly state: string }
  | { readonly t: "agent-create"; readonly id: string; readonly agent: AgentKind }
  | {
      readonly t: "agent-prompt";
      readonly sessionId: string;
      readonly text: string;
      readonly author: Author;
    }
  | { readonly t: "agent-cancel"; readonly sessionId: string }
  | {
      readonly t: "agent-config";
      readonly sessionId: string;
      readonly configId: string;
      readonly value: AgentConfigValue;
    }
  | {
      readonly t: "agent-permission";
      readonly sessionId: string;
      readonly requestId: string;
      readonly optionId: string | null;
      readonly by: string;
    }
  /** Send a file now and on every change, until closed. */
  | { readonly t: "file-open"; readonly path: string }
  | { readonly t: "file-close"; readonly path: string }
  /** Send the shared set's file list now and whenever it changes. */
  | { readonly t: "tree-watch" }
  | { readonly t: "term-open"; readonly id: string; readonly cols: number; readonly rows: number }
  | { readonly t: "term-input"; readonly id: string; readonly data: string }
  | {
      readonly t: "term-resize";
      readonly id: string;
      readonly cols: number;
      readonly rows: number;
    }
  /** The answer to a `board-call`: the tool's text, for the agent, and any images. */
  | {
      readonly t: "board-result";
      readonly callId: string;
      readonly ok: boolean;
      readonly text: string;
      readonly images?: ReadonlyArray<ToolImage>;
    }
  /** Admit a browser by its key (a member's again: its new role and name). */
  | {
      readonly t: "member-admit";
      readonly publicKey: string;
      readonly name: string;
      readonly role: MemberRole;
    }
  | { readonly t: "member-role"; readonly fingerprint: string; readonly role: MemberRole }
  | { readonly t: "member-remove"; readonly fingerprint: string };

/** An image a board tool shows the agent, e.g. a drawing (ADR 0009). */
export interface ToolImage {
  /** base64, no data: prefix. */
  readonly data: string;
  readonly mimeType: "image/png";
}

export type ServerToClient =
  /** Every socket's first message: sign this to show you are an owner. */
  | { readonly t: "challenge"; readonly nonce: string }
  | {
      readonly t: "welcome";
      /** The version `canvas serve` runs as; null for a checkout. */
      readonly version: string | null;
      readonly room: RoomSecrets;
      readonly cwd: string;
      readonly agents: ReadonlyArray<AgentInfo>;
      /** base64 Yjs update of the persisted board, if any. */
      readonly board: string | null;
      readonly sessions: ReadonlyArray<SessionSnapshot>;
      /** The board's `canvas relay`, if it uses one (ADR 0008). */
      readonly relay?: WelcomeRelay | null;
      readonly members: ReadonlyArray<Member>;
    }
  /** The member list, after every change. */
  | { readonly t: "members"; readonly members: ReadonlyArray<Member> }
  | { readonly t: "agent-meta"; readonly meta: SessionMeta }
  | { readonly t: "agent-event"; readonly sessionId: string; readonly event: AgentEvent }
  | AgentOptionsMessage
  | FileMessage
  | TreeMessage
  | { readonly t: "term-data"; readonly id: string; readonly data: string }
  | { readonly t: "term-exit"; readonly id: string; readonly code: number | null }
  /**
   * An agent called a board tool (`shared/board-tools.ts`); the board is in
   * the browser, so the browser runs it. `sessionId` is the agent's frame.
   */
  | {
      readonly t: "board-call";
      readonly callId: string;
      readonly sessionId: string;
      readonly tool: string;
      readonly args: unknown;
    }
  | { readonly t: "error"; readonly message: string };

// ---------------------------------------------------------------------------
// Peer ⇄ peer (trystero actions)

/**
 * A member's saved role (ADR 0011, decision 2), set by the host per member.
 * - `view`: read-only — board edits are dropped, requests refused; sees the
 *   files others open, but not the file tree.
 * - `edit`: edit the board and prompt drafts, open shared files and browse the
 *   tree (ADR 0002); anything that runs on the host's machine (send a prompt,
 *   start an agent) waits for the host to approve it.
 */
export type MemberRole = "view" | "edit";

/**
 * What a guest may do now: its member's role, or `trusted` on top of it for
 * one host session (decision 4, not grantable yet): as `edit`, without the
 * approval step, and typing into terminals. Tool-call permissions the agent
 * asks for still go to the host only.
 */
export type GuestAccess = MemberRole | "trusted";

/** A browser the host admitted, as `canvas serve` saves it (`.canvas/members.json`). */
export interface Member {
  readonly publicKey: string;
  /** The full fingerprint of `publicKey` (`shared/identity.ts`): what members are found by. */
  readonly fingerprint: string;
  /** The name it had when admitted. */
  readonly name: string;
  readonly role: MemberRole;
  /** ISO time it was admitted. */
  readonly admitted: string;
}

/**
 * Host → one guest, once it proved its key: whether it is in. Until
 * `admitted` the host sends it nothing else and refuses what it sends.
 */
export type Admission =
  /** Not a member: wait for the host to let you in. */
  | { readonly t: "lobby" }
  /** In: the room, and the host's state vector to sync against. */
  | {
      readonly t: "admitted";
      readonly access: GuestAccess;
      readonly state: RoomState;
      readonly vector: ReadonlyArray<number>;
    }
  /**
   * The host changed what this member may do. Made able to edit, it gets the
   * host's state vector: what it changed meanwhile was dropped, and later
   * updates of its own wait on it.
   */
  | {
      readonly t: "access";
      readonly access: GuestAccess;
      readonly vector?: ReadonlyArray<number>;
    }
  /** Not let in; the host drops this peer. */
  | { readonly t: "denied" }
  /** No longer a member; the host drops this peer. Coming again is knocking again. */
  | { readonly t: "removed" };

export interface RoomState {
  readonly hostPeerId: string;
  readonly cwd: string;
  readonly agents: ReadonlyArray<AgentInfo>;
  /** `canvas serve`'s version, null for a checkout; absent from hosts older than it. */
  readonly version?: string | null;
}

/** Requests a guest sends the host; the host answers `{ok}` or `{ok:false, error}`. */
export type GuestRequest =
  | { readonly t: "agent-create"; readonly frameId: string; readonly agent: AgentKind }
  | { readonly t: "agent-prompt"; readonly sessionId: string; readonly text: string }
  | { readonly t: "agent-cancel"; readonly sessionId: string }
  | {
      readonly t: "agent-config";
      readonly sessionId: string;
      readonly configId: string;
      readonly value: AgentConfigValue;
    }
  | { readonly t: "term-input"; readonly id: string; readonly data: string };

export type GuestReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Host → guests: the mirrored agent sessions, terminals and open files, and
 * the file tree (not to `view` guests).
 *
 * A joining guest gets `sessions` first — every session on the board, without
 * its log — then one `session-history` per session, shortest first, so a long
 * thread holds up nobody else's.
 */
export type HostBroadcast =
  | { readonly t: "sessions"; readonly sessions: ReadonlyArray<SessionHead> }
  | {
      readonly t: "session-history";
      readonly sessionId: string;
      readonly events: ReadonlyArray<AgentEvent>;
    }
  | { readonly t: "agent-meta"; readonly meta: SessionMeta }
  | { readonly t: "agent-event"; readonly sessionId: string; readonly event: AgentEvent }
  | AgentOptionsMessage
  | { readonly t: "term-data"; readonly id: string; readonly data: string }
  | FileMessage
  | TreeMessage
  /**
   * Who is in, with the fingerprints the host verified, signed with the host
   * key (ADR 0011, decision 5; `web/lib/member-list.ts`).
   */
  | ({ readonly t: "member-list" } & SignedMemberList);

/** A member list's JSON, exactly as signed, and the host key's signature over it. */
export interface SignedMemberList {
  readonly list: string;
  readonly signature: string;
}

export interface FileMessage {
  readonly t: "file";
  readonly path: string;
  readonly file: FileContent;
}

/** Every file in the shared set, working-dir-relative with `/` separators. */
export interface TreeMessage {
  readonly t: "tree";
  readonly paths: ReadonlyArray<string>;
}

/** A session's settings changed (or the agent connected and listed them). */
export interface AgentOptionsMessage {
  readonly t: "agent-options";
  readonly sessionId: string;
  readonly options: ReadonlyArray<AgentConfigOption>;
}
