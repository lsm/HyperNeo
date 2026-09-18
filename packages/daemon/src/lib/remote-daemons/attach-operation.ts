import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { renderRemoteAddress } from '../mailbox/address.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
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

export const AttachDaemonResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('attached'),
    daemonId: z.string(),
    url: z.string(),
    addressExample: z.string(),
  }),
  z.object({ kind: z.literal('rejected'), reason: z.string() }),
]);

type AttachInput = z.infer<typeof AttachDaemonInputSchema>;
type AttachResult = z.infer<typeof AttachDaemonResultSchema>;

export function requireHumanAttachCaller(
  input: AttachInput,
  caller: OperationCaller
): { value: AttachInput } | { reason: AttachResult } {
  return caller.source === 'rpc'
    ? { value: input }
    : {
        reason: {
          kind: 'rejected',
          reason:
            'Attaching a remote daemon is a human-only action; an agent can address a daemon that is already attached but cannot add one.',
        },
      };
}

export function attachRemoteDaemon(
  input: AttachInput,
  registry: RemoteDaemonRegistry
): AttachResult {
  registry.attach(input.daemonId, input.url);
  return {
    kind: 'attached',
    daemonId: input.daemonId,
    url: input.url,
    addressExample: renderRemoteAddress({
      kind: 'remote-session',
      daemonId: input.daemonId,
      sessionId: '<sessionId>',
    }),
  };
}

const runAttachDaemon = (superpipe({})('attach-remote-daemon') as PipelineAPI)
  .input(['input', 'caller', 'registry'])
  .pipe(requireHumanAttachCaller, ['input', 'caller'], 'result:outcome')
  .pipe(attachRemoteDaemon, ['outcome', 'registry'], 'outcome')
  .endAsync('outcome') as (
  input: AttachInput,
  caller: OperationCaller,
  registry: RemoteDaemonRegistry
) => Promise<AttachResult>;

export function createAttachDaemonOperation(registry: RemoteDaemonRegistry) {
  return defineOperation({
    name: 'daemon.attach',
    policy: { safetyClass: 'human_only' },
    description:
      'Attach a remote HyperNeo daemon by MessageHub websocket URL so its sessions become addressable as "daemon:<daemonId>::session:<sessionId>". Only a human acting over RPC can attach a daemon; agents are rejected. The attachment lives in memory for the life of this daemon process and is replaced when the same id is attached again. No connection is opened until the first forwarded call.',
    inputSchema: AttachDaemonInputSchema,
    resultSchema: AttachDaemonResultSchema,
    execute: (input, caller) => runAttachDaemon(input, caller, registry),
  });
}
