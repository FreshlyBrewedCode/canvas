/**
 * Everything `canvas serve` persists lives in `<dir>/.canvas/`:
 *
 *   room.json              room id, trystero key, host keypair; a new id and key
 *                          when the invite link is reset
 *   runtime.json           this runtime's id (ADR 0013, decision 3): the
 *                          machine's, not the board's; kept across resets
 *   owners.json            the browsers paired as host (`owners.ts`)
 *   pairing.json           the pending pairing code, if any (`owners.ts`)
 *   serve.json             the host link's base, for `canvas pair`
 *   board.bin              the latest Yjs state of the board
 *   sessions/<id>.ndjson   one agent session: a meta line, then its events
 *                          (meta lines again as it changes)
 *   agents.json            the settings each kind of agent offered a new
 *                          session last (ADR 0012), shown before any runs
 *
 * Keeping the room stable across restarts keeps the links people already
 * have working, until the host resets the invite link (`rotateRoom`).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  AgentEvent,
  KindOptions,
  RoomSecrets,
  SessionMeta,
  SessionSnapshot,
} from "../shared/protocol";
import { isRuntimeId } from "../shared/address";
import { withDefaults } from "./session-meta";

export type RoomFile = RoomSecrets;

/** Where the running `canvas serve` is reached: what a host link is made of besides the room. */
export interface ServeInfo {
  readonly webUrl: string;
  readonly server: string;
}

const randomId = (bytes: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

export class Store {
  readonly root: string;

  constructor(dir: string) {
    this.root = join(dir, ".canvas");
    mkdirSync(join(this.root, "sessions"), { recursive: true });
  }

  async room(): Promise<RoomFile> {
    const path = join(this.root, "room.json");
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as RoomFile;

    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const room: RoomFile = {
      roomId: randomId(9),
      key: randomId(18),
      hostPublicKey: Buffer.from(raw).toString("base64url"),
      hostPrivateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
    };
    writeFileSync(path, JSON.stringify(room, null, 2), { mode: 0o600 });
    return room;
  }

  /**
   * Reset the invite link (ADR 0011, decision 6): a new room id and key, the
   * same host key — it is the board's, and in every host link. Saved before
   * anyone is told: a host tab that reloads meanwhile comes back to the new one.
   */
  async rotateRoom(): Promise<RoomFile> {
    const room: RoomFile = { ...(await this.room()), roomId: randomId(9), key: randomId(18) };
    const path = join(this.root, "room.json");
    const temp = `${path}.${process.pid}`;
    writeFileSync(temp, JSON.stringify(room, null, 2), { mode: 0o600 });
    renameSync(temp, path);
    return room;
  }

  /**
   * This runtime's id (ADR 0013, decision 3): made the first time, 9 random
   * bytes as base64url. No secret, and not the room's: resetting the invite
   * link keeps it. Deleting the file makes a new one.
   */
  runtime(): string {
    const path = join(this.root, "runtime.json");
    if (existsSync(path)) {
      const { id } = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown };
      if (isRuntimeId(id)) return id;
    }
    const id = randomId(9);
    writeFileSync(path, JSON.stringify({ id }, null, 2));
    return id;
  }

  serveInfo(): ServeInfo | null {
    const path = join(this.root, "serve.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ServeInfo) : null;
  }

  saveServeInfo(info: ServeInfo): void {
    writeFileSync(join(this.root, "serve.json"), JSON.stringify(info, null, 2));
  }

  board(): Uint8Array | null {
    const path = join(this.root, "board.bin");
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }

  saveBoard(state: Uint8Array): void {
    writeFileSync(join(this.root, "board.bin"), state);
  }

  /** Every session's last meta and its events; logs from before ADR 0012 get their meta's new fields. */
  sessions(): SessionSnapshot[] {
    const dir = join(this.root, "sessions");
    return readdirSync(dir)
      .filter((name) => name.endsWith(".ndjson"))
      .flatMap((name) => {
        const path = join(dir, name);
        let meta: SessionMeta | undefined;
        const events: AgentEvent[] = [];
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (!line) continue;
          const record = JSON.parse(line) as { meta?: SessionMeta; event?: AgentEvent };
          if (record.meta) meta = record.meta;
          if (record.event) events.push(record.event);
        }
        return meta ? [{ meta: withDefaults(meta, events, statSync(path).mtimeMs), events }] : [];
      });
  }

  agentOptions(): KindOptions {
    const path = join(this.root, "agents.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as KindOptions) : {};
  }

  saveAgentOptions(options: KindOptions): void {
    writeFileSync(join(this.root, "agents.json"), JSON.stringify(options, null, 2));
  }

  appendMeta(meta: SessionMeta): void {
    appendFileSync(
      join(this.root, "sessions", `${meta.id}.ndjson`),
      `${JSON.stringify({ meta })}\n`,
    );
  }

  appendEvent(sessionId: string, event: AgentEvent): void {
    appendFileSync(
      join(this.root, "sessions", `${sessionId}.ndjson`),
      `${JSON.stringify({ event })}\n`,
    );
  }
}
