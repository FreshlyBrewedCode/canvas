import {
  AUTH_REFUSED,
  HOST_REPLACED,
  type AuthMessage,
  type ClientToServer,
  type ServerToClient,
} from "../../shared/protocol";

/**
 * `replaced`: another tab is the host now; this one waits for `takeOver`.
 * `refused`: this browser isn't an owner of that `canvas serve` (`refusal` says why).
 */
export type LinkStatus = "connecting" | "open" | "closed" | "replaced" | "refused";

/**
 * The host browser's WebSocket to `canvas serve`, reconnecting with backoff.
 * Each socket first answers the server's challenge (`authenticate`); it is
 * open once the welcome comes. Messages sent while not open are dropped: the
 * server re-sends its full state on every (re)connect, so there is nothing to replay.
 */
export class ServerLink {
  private ws: WebSocket | null = null;
  private retry = 0;
  private stopped = false;
  status: LinkStatus = "connecting";
  /** Why `canvas serve` refused us, when `refused`. */
  refusal: string | null = null;

  constructor(
    private readonly url: string,
    private readonly authenticate: (nonce: string) => Promise<AuthMessage>,
    private readonly onMessage: (message: ServerToClient) => void,
    private readonly onStatus: (status: LinkStatus) => void,
  ) {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.setStatus("connecting");
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as ServerToClient;
      if (message.t === "challenge") {
        void this.authenticate(message.nonce).then(
          (answer) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(answer)),
        );
        return;
      }
      if (message.t === "welcome") {
        this.retry = 0;
        this.setStatus("open");
      }
      this.onMessage(message);
    };
    ws.onclose = (event) => {
      if (this.stopped) return this.setStatus("closed");
      if (event.code === HOST_REPLACED) return this.setStatus("replaced");
      if (event.code === AUTH_REFUSED) {
        this.refusal = event.reason || "refused";
        return this.setStatus("refused");
      }
      this.setStatus("closed");
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private setStatus(status: LinkStatus) {
    this.status = status;
    this.onStatus(status);
  }

  send(message: ClientToServer): boolean {
    if (this.status !== "open" || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  /** Connect again after another tab took over, taking over from it in turn. */
  takeOver() {
    if (this.status !== "replaced") return;
    this.retry = 0;
    this.connect();
  }

  close() {
    this.stopped = true;
    this.ws?.close();
  }
}
