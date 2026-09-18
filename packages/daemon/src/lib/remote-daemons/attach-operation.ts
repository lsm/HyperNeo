import { z } from 'zod';
import { renderRemoteAddress } from '../mailbox/address.ts';
import { defineOperation } from '../operations/registry.ts';
import type { RemoteDaemonRegistry } from './registry.ts';

export const AttachDaemonInputSchema = z.object({
  daemonId: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Daemon id must be alphanumeric with . _ -'),
  url: z
    .string()
    .min(1)
    .refine(
      (url) => url.startsWith('ws://') || url.startsWith('wss://'),
      'URL must be a ws:// or wss:// MessageHub endpoint'
    ),
});

export const AttachDaemonResultSchema = z.object({
  kind: z.literal('attached'),
  daemonId: z.string(),
  url: z.string(),
  addressExample: z.string(),
});

export function createAttachDaemonOperation(registry: RemoteDaemonRegistry) {
  return defineOperation({
    name: 'daemon.attach',
    description:
      'Attach a remote HyperNeo daemon by MessageHub websocket URL so its sessions become addressable as "daemon:<daemonId>::session:<sessionId>". The attachment lives in memory for the life of this daemon process and is replaced when the same id is attached again. No connection is opened until the first forwarded call.',
    inputSchema: AttachDaemonInputSchema,
    resultSchema: AttachDaemonResultSchema,
    execute: async ({ daemonId, url }) => {
      registry.attach(daemonId, url);
      return {
        kind: 'attached' as const,
        daemonId,
        url,
        addressExample: renderRemoteAddress({
          kind: 'remote-session',
          daemonId,
          sessionId: '<sessionId>',
        }),
      };
    },
  });
}
