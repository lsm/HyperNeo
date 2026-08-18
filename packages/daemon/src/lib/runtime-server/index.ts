import type { ServerOptions, ServerHandle } from './types';
import { createBunServer } from './bun-backend';
import { createNodeServer } from './node-backend';

export type { RuntimeWebSocketHandler, ServerOptions, ServerHandle, RuntimeSocket } from './types';

declare const Bun: unknown | undefined;

export async function createHttpWsServer(options: ServerOptions): Promise<ServerHandle> {
  if (typeof Bun !== 'undefined') {
    return createBunServer(options);
  }
  return createNodeServer(options);
}
