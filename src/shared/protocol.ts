/**
 * The two wire contracts of canvas, shared by the CLI server and the web app.
 *
 *   guest browser ──trystero──▶ host browser ──WebSocket──▶ `canvas serve`
 *
 * Only the host's browser talks to the server (it holds the token from the
 * link the CLI printed). Guests talk to the host over trystero and never reach
 * the machine directly: every action that would touch it is a request the
 * host's browser checks against the room's access policy before relaying.
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
      readonly error?: string;
      readonly cancelled?: boolean;
    };

export interface SessionSnapshot {
  readonly meta: SessionMeta;
  readonly events: ReadonlyArray<AgentEvent>;
}

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

export type ClientToServer =
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
      readonly t: "agent-permission";
      readonly sessionId: string;
      readonly requestId: string;
      readonly optionId: string | null;
      readonly by: string;
    }
  | { readonly t: "file-watch"; readonly path: string }
  | { readonly t: "file-write"; readonly path: string; readonly content: string }
  | { readonly t: "term-open"; readonly id: string; readonly cols: number; readonly rows: number }
  | { readonly t: "term-input"; readonly id: string; readonly data: string }
  | {
      readonly t: "term-resize";
      readonly id: string;
      readonly cols: number;
      readonly rows: number;
    };

export type ServerToClient =
  | {
      readonly t: "welcome";
      readonly room: RoomSecrets;
      readonly cwd: string;
      readonly agents: ReadonlyArray<AgentInfo>;
      /** base64 Yjs update of the persisted board, if any. */
      readonly board: string | null;
      readonly sessions: ReadonlyArray<SessionSnapshot>;
    }
  | { readonly t: "agent-meta"; readonly meta: SessionMeta }
  | { readonly t: "agent-event"; readonly sessionId: string; readonly event: AgentEvent }
  | { readonly t: "file"; readonly path: string; readonly content: string | null }
  | { readonly t: "term-data"; readonly id: string; readonly data: string }
  | { readonly t: "term-exit"; readonly id: string; readonly code: number | null }
  | { readonly t: "error"; readonly message: string };

// ---------------------------------------------------------------------------
// Peer ⇄ peer (trystero actions)

/**
 * What a guest may do, set by the host for the whole room.
 * - `view`: read-only — board edits are dropped, requests refused.
 * - `edit`: edit the board and prompt drafts; anything that runs on the host's
 *   machine (send a prompt, start an agent, type into a terminal) waits for
 *   the host to approve it.
 * - `trusted`: as `edit`, without the approval step. Tool-call permissions the
 *   agent asks for still go to the host only.
 */
export type GuestAccess = "view" | "edit" | "trusted";

export interface RoomState {
  readonly hostPeerId: string;
  readonly access: GuestAccess;
  readonly cwd: string;
  readonly agents: ReadonlyArray<AgentInfo>;
}

/** Requests a guest sends the host; the host answers `{ok}` or `{ok:false, error}`. */
export type GuestRequest =
  | { readonly t: "agent-create"; readonly frameId: string; readonly agent: AgentKind }
  | { readonly t: "agent-prompt"; readonly sessionId: string; readonly text: string }
  | { readonly t: "agent-cancel"; readonly sessionId: string }
  | { readonly t: "term-input"; readonly id: string; readonly data: string };

export type GuestReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Host → guests: the mirrored agent sessions and terminals. */
export type HostBroadcast =
  | { readonly t: "sessions"; readonly sessions: ReadonlyArray<SessionSnapshot> }
  | { readonly t: "agent-meta"; readonly meta: SessionMeta }
  | { readonly t: "agent-event"; readonly sessionId: string; readonly event: AgentEvent }
  | { readonly t: "term-data"; readonly id: string; readonly data: string };
