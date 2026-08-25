export interface RuntimeSocket<TData = unknown> {
  data: TData;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export interface RuntimeWebSocketHandler<TData = unknown> {
  open?(ws: RuntimeSocket<TData>): void | Promise<void>;
  message?(ws: RuntimeSocket<TData>, message: string | Uint8Array): void | Promise<void>;
  close?(ws: RuntimeSocket<TData>): void | Promise<void>;
  error?(ws: RuntimeSocket<TData>, error: unknown): void | Promise<void>;
}

export type UpgradeFn = <TData>(req: Request, data: TData) => Response | null;

export interface ServerOptions {
  hostname: string;
  port: number;
  idleTimeoutSeconds?: number;
  fetch: (req: Request, upgrade: UpgradeFn) => Response | undefined | Promise<Response | undefined>;
  websocket?: RuntimeWebSocketHandler;
  onError?: (error: unknown) => Response | Promise<Response>;
}

export type CreateServerFn = (options: ServerOptions) => Promise<ServerHandle>;

export interface ServerHandle {
  readonly hostname: string;
  readonly port: number;
  stop(closeActiveConnections?: boolean): void;
}
