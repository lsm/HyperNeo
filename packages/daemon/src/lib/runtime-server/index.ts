// Runtime-agnostic HTTP + WebSocket server.
//
// The daemon's HTTP/WS server historically used `Bun.serve` with
// `server.upgrade()` and a `websocket:` handler — Bun-specific APIs that
// prevent the daemon from booting under Node (and, later, Deno). This module
// provides a single `createHttpWsServer()` entry point with per-runtime
// backends, selected automatically:
//
// - Bun backend  → wraps `Bun.serve` (behavior unchanged).
// - Node backend → `node:http` + the `ws` package (used by tests / Node).
//
// A Deno backend can slot in later via the same interface.
//
// The caller supplies a `fetch(req, upgrade)` handler. Inside it, calling
// `upgrade(req, data)` performs the WebSocket handshake for that request and
// returns a `RuntimeSocket`; returning the upgrade's response completes the
// handshake. Per-connection `data` (replacing Bun's `ws.data`) is attached to
// the returned socket and passed to the WS handler callbacks.

import type { ServerOptions, ServerHandle } from './types';
import { createBunServer } from './bun-backend';
import { createNodeServer } from './node-backend';

export type { RuntimeWebSocketHandler, ServerOptions, ServerHandle, RuntimeSocket } from './types';

declare const Bun: unknown | undefined;

/**
 * Create an HTTP + WebSocket server bound to `hostname:port`.
 *
 * @param options.fetch  Request handler. Receives the Request and an
 *   `upgrade(req, data)` callback for WebSocket upgrades.
 * @param options.websocket  Per-connection WebSocket callbacks.
 * @param options.onError  Error handler returning a Response.
 */
export async function createHttpWsServer(options: ServerOptions): Promise<ServerHandle> {
  if (typeof Bun !== 'undefined') {
    return createBunServer(options);
  }
  return createNodeServer(options);
}
