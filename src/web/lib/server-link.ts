import type { ClientToServer, ServerToClient } from "../../shared/protocol";

export type LinkStatus = "connecting" | "open" | "closed";

/**
 * The host browser's WebSocket to `canvas serve`, reconnecting with backoff.
 * Messages sent while disconnected are dropped: the server re-sends its full
 * state on every (re)connect, so there is nothing to replay.
 */
export class ServerLink {
  private ws: WebSocket | null = null;
  private retry = 0;
  private stopped = false;
  status: LinkStatus = "connecting";

  constructor(
    private readonly url: string,
    private readonly onMessage: (message: ServerToClient) => void,
    private readonly onStatus: (status: LinkStatus) => void,
  ) {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.setStatus("connecting");
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus("open");
    };
    ws.onmessage = (event) => this.onMessage(JSON.parse(String(event.data)) as ServerToClient);
    ws.onclose = () => {
      this.setStatus("closed");
      if (this.stopped) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private setStatus(status: LinkStatus) {
    this.status = status;
    this.onStatus(status);
  }

  send(message: ClientToServer): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  close() {
    this.stopped = true;
    this.ws?.close();
  }
}
