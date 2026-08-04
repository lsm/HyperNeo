// Node backend for the runtime-server abstraction. Uses `node:http` for the
// fetch handler and the `ws` package (WebSocketServer in noServer mode) for
// /ws upgrades. Each upgraded socket is wrapped in a RuntimeSocket whose
// `data` is the per-connection bag supplied to `upgrade()`.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { RuntimeSocket, ServerHandle, ServerOptions, UpgradeFn } from './types';

// Convert a node:http IncomingMessage into a WHATWG Request for the fetch handler.
function toRequest(req: IncomingMessage, hostname: string, port: number): Request {
  const url = `http://${hostname}:${port}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return new Request(url, { method: req.method, headers });
}

// Write a WHATWG Response out to a node:http ServerResponse.
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
      // For non-upgrade HTTP requests, upgrade() should never be called. If it
      // is, return a truthy 200 sentinel (Node's Response rejects status 101).
      // The real WS handshake is handled entirely in the 'upgrade' event below.
      return new Response(null, { status: 200 });
    };

    const boundPort = (server.address() as { port: number } | null)?.port ?? options.port;
    const request = toRequest(req, hostname, boundPort);

    Promise.resolve(fetch(request, upgrade))
      .then((response) => {
        // Any response from the non-upgrade HTTP path is written as-is. A 200
        // sentinel (from upgrade() being called on a non-WS request) falls
        // through as a 200 with empty body — harmless and never expected in
        // practice because Node routes WS upgrades through the 'upgrade' event.
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

  // In Node, HTTP requests with `Upgrade: websocket` are delivered ONLY via
  // the 'upgrade' event — the 'request' event (and thus the createServer
  // callback above) never fires for them. This is the opposite of Bun, where
  // every request enters `fetch` and `server.upgrade()` is called from inside
  // fetch. To preserve the single fetch(req, upgrade) contract across
  // runtimes, we invoke the same fetch handler here, letting it call
  // upgrade(req, data) to approve the connection. We then complete the WS
  // handshake with the `ws` package.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const boundPort = (server.address() as { port: number } | null)?.port ?? options.port;
    const request = toRequest(req, hostname, boundPort);

    // Box to capture whether upgrade() was called and with what data. Using a
    // mutable container (not the WeakMap approach) because the fetch handler
    // runs synchronously here — we read `approved` immediately after.
    let approved = false;
    let upgradeData: unknown = undefined;
    const upgrade: UpgradeFn = <TData>(_upgradeReq: Request, data: TData) => {
      approved = true;
      upgradeData = data;
      // Return a truthy sentinel so the caller's `if (upgradeResponse) return ...`
      // branch is taken. Node's WHATWG Response constructor rejects status 101
      // (only 200-599 are valid), so we cannot mimic the Bun backend's 101
      // sentinel — and we don't need to: this Response is never written to the
      // wire because the 'upgrade' event owns the raw socket. A 200 is the
      // cheapest valid Response to construct.
      return new Response(null, { status: 200 });
    };

    // Run the fetch handler. It may be async, but the decision to call
    // upgrade() for /ws is made synchronously in the daemon's setup-websocket
    // fetch handler (no awaits before upgrade()), so we can await the result
    // and then check `approved`. If the handler rejected, destroy the socket.
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

  // Wait until the server is actually listening so `port` reports the real
  // bound port (critical when 0 is requested for OS-assigned ports).
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
