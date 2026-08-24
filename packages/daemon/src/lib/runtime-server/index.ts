import type { ServerOptions, ServerHandle } from './types.ts';
import { createBunServer } from './bun-backend.ts';
import { createNodeServer } from './node-backend.ts';

export type {
  RuntimeWebSocketHandler,
  ServerOptions,
  ServerHandle,
  RuntimeSocket,
} from './types.ts';

declare const Bun: unknown | undefined;

export async function createHttpWsServer(options: ServerOptions): Promise<ServerHandle> {
  if (typeof Bun !== 'undefined') {
    return createBunServer(options);
  }
  return createNodeServer(options);
}
