/**
 * A transport's channels (`transport.ts`): what goes to one peer or everyone,
 * and request/reply to one peer. Without a DOM: the board's authority sends
 * and takes on them (`room/authority.ts`).
 */

/** Anything JSON, or bytes. */
export type Payload = unknown;

export interface MessageContext {
  readonly peerId: string;
}

export interface SendOptions {
  /** One peer or several; absent: everyone. */
  readonly target?: string | ReadonlyArray<string>;
}

export interface Channel<T extends Payload = Payload> {
  send(data: T, options?: SendOptions): Promise<void>;
  onMessage: ((data: T, context: MessageContext) => void | Promise<void>) | null;
}

export interface RequestChannel<T extends Payload = Payload, R extends Payload = Payload> {
  request(data: T, options: { readonly target: string; readonly timeoutMs?: number }): Promise<R>;
  onRequest: ((data: T, context: MessageContext) => R | Promise<R>) | null;
}
