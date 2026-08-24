import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { RuntimeSocket, ServerHandle, ServerOptions, UpgradeFn } from './types.ts';

function toRequest(
  req: IncomingMessage,
  hostname: string,
  port: number,
  clientSignal?: AbortSignal
): Request {
  const url = `http://${hostname}:${port}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init: RequestInit = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    (init as { duplex?: 'half' }).duplex = 'half';
  }
  if (clientSignal) init.signal = clientSignal;
  return new Request(url, init);
}

function clientIsGone(res: ServerResponse): boolean {
  return res.destroyed || res.writableEnded;
}

function waitForDrain(res: ServerResponse): Promise<void> {
  if (clientIsGone(res)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const settle = () => {
      res.off('drain', settle);
      res.off('error', settle);
      res.off('close', settle);
      resolve();
    };
    res.once('drain', settle);
    res.once('error', settle);
    res.once('close', settle);
  });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  let closed = false;
  const onClientGone = () => {
    closed = true;
    void reader.cancel().catch(() => {});
  };
  res.once('close', onClientGone);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (closed || clientIsGone(res)) break;
      if (!res.write(value)) {
        if (closed || clientIsGone(res)) break;
        await waitForDrain(res);
        if (closed || clientIsGone(res)) break;
      }
    }
    if (!closed && !clientIsGone(res)) {
      res.end();
    }
  } catch {
    res.destroy();
  } finally {
    res.off('close', onClientGone);
    await reader.cancel().catch(() => {});
  }
}

export async function createNodeServer(options: ServerOptions): Promise<ServerHandle> {
  const { hostname, fetch, websocket, onError } = options;
  const wss = websocket ? new WebSocketServer({ noServer: true }) : null;

  const server = createServer((req, res) => {
    const upgrade: UpgradeFn = <TData>(_upgradeReq: Request, _data: TData) => {
      return new Response(null, { status: 200 });
    };

    const clientGone = new AbortController();
    const onClientGone = () => clientGone.abort();
    res.once('close', onClientGone);

    const boundPort = (server.address() as { port: number } | null)?.port ?? options.port;
    const request = toRequest(req, hostname, boundPort, clientGone.signal);

    Promise.resolve(fetch(request, upgrade))
      .then((response) => {
        res.off('close', onClientGone);
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

  if (wss) {
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
          if (!approved || !wss) {
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
              void websocket?.message?.(runtimeSocket, msg);
            });
            ws.on('close', () => {
              void websocket?.close?.(runtimeSocket);
            });
            ws.on('error', (error: unknown) => {
              void websocket?.error?.(runtimeSocket, error);
            });
            void websocket?.open?.(runtimeSocket);
          });
        })
        .catch(() => {
          socket.destroy();
        });
    });
  }

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
    stop(closeActiveConnections?: boolean) {
      if (wss) {
        for (const client of wss.clients) {
          client.close();
        }
      }
      if (closeActiveConnections) {
        server.closeAllConnections?.();
      }
      server.close();
    },
  };
}
