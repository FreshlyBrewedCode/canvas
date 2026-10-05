import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import * as Y from "yjs";

import { Store } from "../../../server/store";
import type {
  Admission,
  ClientToServer,
  GuestReply,
  Member,
  MemberRole,
} from "../../../shared/protocol";
import { loadBrowserKey, provePeer, type BrowserKey } from "../identity-key";
import { Authority, NOT_REACHABLE } from "./authority";
import type { Channels, Hello } from "./channels";
import { Mirror } from "./mirror";
import { Emitter } from "./topics";
import type { Channel, RequestChannel } from "../transport/channel";

/** What the authority sent, on which channel, to whom. */
interface Sent {
  readonly channel: string;
  readonly data: unknown;
  readonly target: unknown;
}

const browserKey = () => {
  let pair: CryptoKeyPair | undefined;
  return loadBrowserKey({ get: async () => pair, keep: async (p) => (pair ??= p) });
};

const member = (key: BrowserKey, role: MemberRole): Member => ({
  publicKey: key.publicKey,
  fingerprint: key.fingerprint,
  name: "Ada",
  role,
  admitted: "2026-10-01T00:00:00.000Z",
});

/** An authority in a host's tab, on fake channels, with `canvas serve` open or not. */
async function host({ open = true } = {}) {
  const room = await new Store(mkdtempSync(joinPath(tmpdir(), "canvas-authority-"))).room();
  const link = {
    roomId: room.roomId,
    key: room.key,
    hostPublicKey: room.hostPublicKey,
    host: { server: "ws://serve", pair: null },
    relay: null,
  };
  const doc = new Y.Doc();
  const emitter = new Emitter();
  const mirror = new Mirror(emitter, { host: true, runtime: () => "rt-own", onGap: () => {} });
  const sent: Sent[] = [];
  const served: ClientToServer[] = [];
  const channel = (name: string): Channel & RequestChannel => ({
    send: async (data, options) => void sent.push({ channel: name, data, target: options?.target }),
    request: async () => ({}),
    onMessage: null,
    onRequest: null,
  });
  const channels = {
    hello: channel("hello"),
    identify: channel("identify"),
    admission: channel("admission"),
    broadcast: channel("hostcast"),
    update: channel("yupdate"),
    sync: channel("ysync"),
    presence: channel("presence"),
    request: channel("request"),
  } as unknown as Channels;
  const authority = new Authority({
    doc,
    mirror,
    selfId: "host-peer",
    fingerprint: "f".repeat(32),
    identity: { name: "Karl", color: "#f97316" },
    link: () => link,
    state: () => ({
      hostPeerId: "host-peer",
      runtime: "rt-own",
      cwd: "/p",
      agents: [],
      version: "1",
    }),
    presence: {
      send: () => {},
      drop: () => {},
      nameOf: () => ({ name: "Ada", color: "#3b82f6" }),
      showFingerprints: () => {},
    },
    runtime: { open, send: (message) => void served.push(message) },
    relocate: () => {},
    screen: () => 800,
    emit: () => {},
    record: () => {},
  });
  authority.welcome(room.hostPrivateKey, null);
  authority.attach({ channels, peers: () => [] });

  /** A guest's browser joins: the hello, its answer, and what the host said about it. */
  const join = async (peerId: string, key: BrowserKey) => {
    await authority.arrive(peerId);
    const hello = sent.findLast((s) => s.channel === "hello" && s.target === peerId)!;
    const { nonce } = hello.data as Hello;
    const proof = await provePeer(key, link.roomId, peerId, nonce, "seal");
    await channels.identify.onMessage!({ ...proof, name: "Ada", color: "#3b82f6" }, { peerId });
    return said(peerId);
  };
  const said = (peerId: string) =>
    sent
      .filter((s) => s.channel === "admission" && s.target === peerId)
      .map((s) => (s.data as Admission).t);
  /** A change made in a guest's doc, sent to the host. */
  const edit = (peerId: string, key: string) => {
    const theirs = new Y.Doc();
    theirs.getMap("e2e").set(key, 1);
    channels.update.onMessage!(Y.encodeStateAsUpdate(theirs), { peerId });
    return doc.getMap("e2e").has(key);
  };
  const ask = (peerId: string, request: unknown) =>
    channels.request.onRequest!(request, { peerId }) as Promise<GuestReply>;
  return { authority, join, said, edit, ask, served, sent };
}

describe("the board's authority", () => {
  test("a guest's updates count only once it is in, and only if its role may edit", async () => {
    const { authority, join, edit } = await host();
    const ada = await browserKey();
    expect(await join("ada", ada)).toEqual(["lobby"]);
    expect(edit("ada", "from the lobby")).toBe(false);

    authority.setMembers([member(ada, "view")]);
    expect(authority.knocks).toEqual([]);
    expect(edit("ada", "as a viewer")).toBe(false);

    authority.setMembers([member(ada, "edit")]);
    expect(edit("ada", "as an editor")).toBe(true);
  });

  test("a member is let in at once, and its updates go on to the others in", async () => {
    const { authority, join, sent } = await host();
    const [ada, bob] = [await browserKey(), await browserKey()];
    authority.setMembers([member(ada, "edit"), member(bob, "view")]);
    expect(await join("ada", ada)).toEqual(["admitted"]);
    expect(await join("bob", bob)).toEqual(["admitted"]);
    expect(authority.admitted().sort()).toEqual(["ada", "bob"]);

    const update = new Uint8Array([1, 2, 3]);
    authority.onUpdate(update, { peer: "ada" });
    expect(sent.filter((s) => s.data === update).map((s) => s.target)).toEqual([["bob"]]);
  });

  test("a guest's request is checked against its role before it reaches canvas serve", async () => {
    const { authority, join, ask, served } = await host();
    const ada = await browserKey();
    const cancel = { t: "agent-cancel", sessionId: "s1" };
    expect(await ask("ada", cancel)).toEqual({ ok: false, error: expect.any(String) });

    authority.setMembers([member(ada, "edit")]);
    await join("ada", ada);
    expect(await ask("ada", { ...cancel, runtime: "rt-other" })).toEqual({
      ok: false,
      error: NOT_REACHABLE,
    });
    expect(served).toEqual([]);
    expect(await ask("ada", cancel)).toEqual({ ok: true });
    expect(served).toEqual([{ t: "agent-cancel", sessionId: "s1" }]);
  });

  test("nothing runs while canvas serve isn't there", async () => {
    const { authority } = await host({ open: false });
    expect(() =>
      authority.execute({ t: "agent-cancel", sessionId: "s1" }, { name: "Karl", color: "#000" }),
    ).toThrow("not connected to canvas serve");
  });
});
