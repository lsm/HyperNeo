// Shared types for the runtime-server abstraction.

/**
 * A WebSocket connection, normalized across runtimes. Exposes the subset of
 * the WHATWG WebSocket surface the daemon's transport relies on
 * (`send`/`close`/`readyState`), plus a per-connection `data` bag (replacing
 * Bun's `ws.data`).
 */
export interface RuntimeSocket<TData = unknown> {
  /** Per-connection data set at upgrade time and mutated by handlers. */
  data: TData;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  /** 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED (WHATWG semantics). */
  readonly readyState: number;
}

/**
 * Per-connection WebSocket callbacks, mirroring the shape the daemon's
 * `createWebSocketHandlers` already produces.
 */
export interface RuntimeWebSocketHandler<TData = unknown> {
  open?(ws: RuntimeSocket<TData>): void | Promise<void>;
  message?(ws: RuntimeSocket<TData>, message: string | Uint8Array): void | Promise<void>;
  close?(ws: RuntimeSocket<TData>): void | Promise<void>;
  error?(ws: RuntimeSocket<TData>, error: unknown): void | Promise<void>;
}

/**
 * Upgrade callback passed to the fetch handler. Performs the WebSocket
 * handshake for `req`, attaching `data` to the new connection, and returns the
 * handshake Response to send back (or null if the upgrade failed).
 */
export type UpgradeFn = <TData>(req: Request, data: TData) => Response | null;

export interface ServerOptions {
  hostname: string;
  port: number;
  fetch: (req: Request, upgrade: UpgradeFn) => Response | undefined | Promise<Response | undefined>;
  websocket: RuntimeWebSocketHandler;
  onError?: (error: unknown) => Response | Promise<Response>;
}

/**
 * Factory type: backends return a Promise that resolves once the server is
 * listening (so `port` reports the actual bound port, critical when 0 is
 * requested for OS assignment).
 */
export type CreateServerFn = (options: ServerOptions) => Promise<ServerHandle>;

export interface ServerHandle {
  /** The hostname the server is bound to. */
  readonly hostname: string;
  /** The actual bound port (after OS assignment when 0 was requested). */
  readonly port: number;
  stop(): void;
}
