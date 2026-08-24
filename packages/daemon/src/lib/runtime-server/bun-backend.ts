import type { RuntimeSocket, ServerHandle, ServerOptions, UpgradeFn } from './types.ts';

type BunWebSocket = {
  data: unknown;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
};

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    fetch: (req: Request, server: BunServer) => unknown;
    websocket: unknown;
    error?: (error: unknown) => unknown;
  }): BunServer;
};

interface BunServer {
  port: number;
  stop(closeActiveConnections?: boolean): void;
  upgrade(req: Request, options: { data: unknown }): boolean;
}

export async function createBunServer(options: ServerOptions): Promise<ServerHandle> {
  const { hostname, port, fetch, websocket, onError } = options;

  const bunHandlers = {
    open(ws: BunWebSocket) {
      return websocket.open?.(ws as unknown as RuntimeSocket);
    },
    message(ws: BunWebSocket, message: string | Buffer) {
      const msg = typeof message === 'string' ? message : new Uint8Array(message);
      return websocket.message?.(ws as unknown as RuntimeSocket, msg);
    },
    close(ws: BunWebSocket) {
      return websocket.close?.(ws as unknown as RuntimeSocket);
    },
    error(ws: BunWebSocket, error: unknown) {
      return websocket.error?.(ws as unknown as RuntimeSocket, error);
    },
  };

  const server = Bun.serve({
    hostname,
    port,
    fetch(req: Request, bunServer: BunServer) {
      const upgrade: UpgradeFn = <TData>(upgradeReq: Request, data: TData) => {
        const ok = bunServer.upgrade(upgradeReq, { data });
        return ok ? new Response(null, { status: 101 }) : null;
      };
      return fetch(req, upgrade);
    },
    websocket: bunHandlers,
    error: onError
      ? (error: unknown) => {
          return onError(error);
        }
      : undefined,
  });

  return {
    hostname,
    port: server.port,
    stop() {
      server.stop();
    },
  };
}
