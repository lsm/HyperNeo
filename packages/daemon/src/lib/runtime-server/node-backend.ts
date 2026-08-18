import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { RuntimeSocket, ServerHandle, ServerOptions, UpgradeFn } from './types';

function toRequest(req: IncomingMessage, hostname: string, port: number): Request {
  const url = `http://${hostname}:${port}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return new Request(url, { method: req.method, headers });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(await response.text());
}

export async function createNodeServer(options: ServerOptions): Promise<ServerHandle> {
  const { hostname, fetch, websocket, onError } = options;
  const wss = new WebSocketServer({ noServer: true });

  const server = createServer((req, res) => {
    const upgrade: UpgradeFn = <TData>(_upgradeReq: Request, _data: TData) => {
      return new Response(null, { status: 200 });
    };

    const boundPort = (server.address() as { port: number } | null)?.port ?? options.port;
    const request = toRequest(req, hostname, boundPort);

    Promise.resolve(fetch(request, upgrade))
      .then((response) => {
        if (response) {
          void writeResponse(res, response);
        } else {
          void writeResponse(res, new Response('Not found', { status: 404 }));
        }
      })
      .catch((error) => {
        if (onError) {
          void Promise.resolve(onError(error)).then((r) => writeResponse(res, r));
        } else {
          res.statusCode = 500;
          res.end('Internal server error');
        }
      });
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const boundPort = (server.address() as { port: number } | null)?.port ?? options.port;
    const request = toRequest(req, hostname, boundPort);

    let approved = false;
    let upgradeData: unknown = undefined;
    const upgrade: UpgradeFn = <TData>(_upgradeReq: Request, data: TData) => {
      approved = true;
      upgradeData = data;
      return new Response(null, { status: 200 });
    };

    Promise.resolve(
      (async () => {
        const r = await fetch(request, upgrade);
        return r;
      })()
    )
      .then(() => {
        if (!approved) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const runtimeSocket: RuntimeSocket = {
            data: upgradeData,
            send(message: string) {
              ws.send(message);
            },
            close(code?: number, reason?: string) {
              ws.close(code, reason);
            },
            get readyState() {
              return ws.readyState;
            },
          };
          ws.on('message', (raw: Buffer, isBinary: boolean) => {
            const msg = isBinary ? new Uint8Array(raw) : raw.toString();
            void websocket.message?.(runtimeSocket, msg);
          });
          ws.on('close', () => {
            void websocket.close?.(runtimeSocket);
          });
          ws.on('error', (error: unknown) => {
            void websocket.error?.(runtimeSocket, error);
          });
          void websocket.open?.(runtimeSocket);
        });
      })
      .catch(() => {
        socket.destroy();
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
    server.listen(options.port, hostname);
  });

  return {
    hostname,
    get port() {
      const addr = server.address();
      return typeof addr === 'object' && addr ? addr.port : options.port;
    },
    stop() {
      for (const client of wss.clients) {
        client.close();
      }
      server.close();
    },
  };
}
