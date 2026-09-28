import { selfId } from "trystero";

import type { BoardLink, RelayLink } from "../link";
import { relayTransport } from "./relay";
import type { Transport, TransportError } from "./transport";
import { trysteroTransport } from "./trystero";

/**
 * The transport for a board (ADR 0008): through its relay if it has one —
 * for everything, or only to meet — else trystero on Nostr.
 */
export function openTransport(
  link: BoardLink,
  relay: RelayLink | null,
  appId: string,
  onError: TransportError,
): Transport {
  if (relay?.via === "transport")
    return relayTransport(
      { url: relay.url, token: relay.token, boardKey: link.key, selfId },
      onError,
    );
  return trysteroTransport(
    {
      appId,
      password: link.key,
      roomId: link.roomId,
      ...(relay && { signalUrl: `${relay.url}/signal?t=${encodeURIComponent(relay.token)}` }),
    },
    onError,
  );
}
