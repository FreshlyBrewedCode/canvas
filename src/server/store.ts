/**
 * Everything `canvas serve` persists lives in `<dir>/.canvas/`:
 *
 *   room.json              room id, trystero key, host keypair, host token
 *   board.bin              the latest Yjs state of the board
 *   sessions/<id>.ndjson   one agent session: a meta line, then its events
 *
 * Keeping the room stable across restarts keeps the links people already
 * have working.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, RoomSecrets, SessionMeta, SessionSnapshot } from "../shared/protocol";

export interface RoomFile extends RoomSecrets {
  /** Proves a WebSocket client is the host's browser. */
  readonly token: string;
}

const randomId = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

export class Store {
  private readonly root: string;

  constructor(dir: string) {
    this.root = join(dir, ".canvas");
    mkdirSync(join(this.root, "sessions"), { recursive: true });
  }

  async room(): Promise<RoomFile> {
    const path = join(this.root, "room.json");
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as RoomFile;

    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const room: RoomFile = {
      roomId: randomId(9),
      key: randomId(18),
      hostPublicKey: Buffer.from(raw).toString("base64url"),
      hostPrivateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
      token: randomId(24),
    };
    writeFileSync(path, JSON.stringify(room, null, 2), { mode: 0o600 });
    return room;
  }

  board(): Uint8Array | null {
    const path = join(this.root, "board.bin");
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  }

  saveBoard(state: Uint8Array): void {
    writeFileSync(join(this.root, "board.bin"), state);
  }

  sessions(): SessionSnapshot[] {
    const dir = join(this.root, "sessions");
    return readdirSync(dir)
      .filter((name) => name.endsWith(".ndjson"))
      .flatMap((name) => {
        let meta: SessionMeta | undefined;
        const events: AgentEvent[] = [];
        for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
          if (!line) continue;
          const record = JSON.parse(line) as { meta?: SessionMeta; event?: AgentEvent };
          if (record.meta) meta = record.meta;
          if (record.event) events.push(record.event);
        }
        return meta ? [{ meta, events }] : [];
      });
  }

  appendMeta(meta: SessionMeta): void {
    appendFileSync(join(this.root, "sessions", `${meta.id}.ndjson`), `${JSON.stringify({ meta })}\n`);
  }

  appendEvent(sessionId: string, event: AgentEvent): void {
    appendFileSync(join(this.root, "sessions", `${sessionId}.ndjson`), `${JSON.stringify({ event })}\n`);
  }
}
