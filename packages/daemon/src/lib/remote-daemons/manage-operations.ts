import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { renderRemoteAddressExample } from '../mailbox/address.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { RemoteDaemonRegistry } from './registry.ts';

const RPC_ONLY_REASON =
  'Managing or probing a remote daemon is restricted to the RPC door; an agent can address a daemon that is already attached but cannot inspect, probe, or remove one.';

const Rejected = z.object({ kind: z.literal('rejected'), reason: z.string() });

export const ListDaemonsInputSchema = z.object({}).default({});

export const ListDaemonsResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('listed'),
    daemons: z.array(
      z.object({ daemonId: z.string(), url: z.string(), addressExample: z.string() })
    ),
  }),
  Rejected,
]);

export const DetachDaemonInputSchema = z.object({ daemonId: z.string().min(1) });

export const ProbeDaemonInputSchema = z.object({
  url: z
    .string()
    .min(1)
    .refine(
      (url) => url.startsWith('ws://') || url.startsWith('wss://'),
      'URL must be a ws:// or wss:// MessageHub endpoint'
    ),
});

export const ProbeDaemonResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reachable'), url: z.string() }),
  z.object({ kind: z.literal('unreachable'), url: z.string(), reason: z.string() }),
  Rejected,
]);

export const DetachDaemonResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('detached'), daemonId: z.string() }),
  z.object({ kind: z.literal('not_attached'), daemonId: z.string() }),
  Rejected,
]);

type ListInput = z.input<typeof ListDaemonsInputSchema>;
type ListResult = z.infer<typeof ListDaemonsResultSchema>;
type DetachInput = z.infer<typeof DetachDaemonInputSchema>;
type DetachResult = z.infer<typeof DetachDaemonResultSchema>;
type ProbeInput = z.infer<typeof ProbeDaemonInputSchema>;
type ProbeResult = z.infer<typeof ProbeDaemonResultSchema>;

export function requireRpcDaemonCaller<Input>(
  input: Input,
  caller: OperationCaller
): { value: Input } | { reason: z.infer<typeof Rejected> } {
  return caller.source === 'rpc'
    ? { value: input }
    : { reason: { kind: 'rejected', reason: RPC_ONLY_REASON } };
}

export function listRemoteDaemons(_input: ListInput, registry: RemoteDaemonRegistry): ListResult {
  return {
    kind: 'listed',
    daemons: registry.list().map(({ daemonId, url }) => ({
      daemonId,
      url,
      addressExample: renderRemoteAddressExample(daemonId),
    })),
  };
}

export function detachRemoteDaemon(
  input: DetachInput,
  registry: RemoteDaemonRegistry
): DetachResult {
  return registry.detach(input.daemonId)
    ? { kind: 'detached', daemonId: input.daemonId }
    : { kind: 'not_attached', daemonId: input.daemonId };
}

export async function probeRemoteDaemon(
  input: ProbeInput,
  registry: RemoteDaemonRegistry
): Promise<ProbeResult> {
  try {
    await registry.probe(input.url);
    return { kind: 'reachable', url: input.url };
  } catch (error) {
    return {
      kind: 'unreachable',
      url: input.url,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const runListDaemons = (superpipe({})('list-remote-daemons') as PipelineAPI)
  .input(['input', 'caller', 'registry'])
  .pipe(requireRpcDaemonCaller, ['input', 'caller'], 'result:outcome')
  .pipe(listRemoteDaemons, ['outcome', 'registry'], 'outcome')
  .endAsync('outcome') as (
  input: ListInput,
  caller: OperationCaller,
  registry: RemoteDaemonRegistry
) => Promise<ListResult>;

const runDetachDaemon = (superpipe({})('detach-remote-daemon') as PipelineAPI)
  .input(['input', 'caller', 'registry'])
  .pipe(requireRpcDaemonCaller, ['input', 'caller'], 'result:outcome')
  .pipe(detachRemoteDaemon, ['outcome', 'registry'], 'outcome')
  .endAsync('outcome') as (
  input: DetachInput,
  caller: OperationCaller,
  registry: RemoteDaemonRegistry
) => Promise<DetachResult>;

const runProbeDaemon = (superpipe({})('probe-remote-daemon') as PipelineAPI)
  .input(['input', 'caller', 'registry'])
  .pipe(requireRpcDaemonCaller, ['input', 'caller'], 'result:outcome')
  .pipe(probeRemoteDaemon, ['outcome', 'registry'], 'outcome')
  .endAsync('outcome') as (
  input: ProbeInput,
  caller: OperationCaller,
  registry: RemoteDaemonRegistry
) => Promise<ProbeResult>;

export function createListDaemonsOperation(registry: RemoteDaemonRegistry) {
  return defineOperation({
    name: 'daemon.list',
    policy: { safetyClass: 'human_only' },
    description:
      'List the remote HyperNeo daemons currently attached to this daemon, with the address prefix each one answers to. Only a caller on the RPC door may list them; agent callers are rejected. The list lives in memory and is empty again after this daemon process restarts.',
    inputSchema: ListDaemonsInputSchema,
    resultSchema: ListDaemonsResultSchema,
    execute: (input, caller) => runListDaemons(input, caller, registry),
  });
}

export function createDetachDaemonOperation(registry: RemoteDaemonRegistry) {
  return defineOperation({
    name: 'daemon.detach',
    policy: { safetyClass: 'human_only' },
    description:
      'Detach a remote HyperNeo daemon so its sessions stop being addressable and any open connection to it is closed. Only a caller on the RPC door may detach a daemon; agent callers are rejected.',
    inputSchema: DetachDaemonInputSchema,
    resultSchema: DetachDaemonResultSchema,
    execute: (input, caller) => runDetachDaemon(input, caller, registry),
  });
}

export function createProbeDaemonOperation(registry: RemoteDaemonRegistry) {
  return defineOperation({
    name: 'daemon.probe',
    policy: { safetyClass: 'human_only' },
    description:
      'Test a remote HyperNeo MessageHub websocket URL by opening a temporary connection and invoking operations.list under the existing connect deadline. Only a caller on the RPC door may probe a URL; agent callers are rejected, and probing does not attach the daemon or accept caller identity input.',
    inputSchema: ProbeDaemonInputSchema,
    resultSchema: ProbeDaemonResultSchema,
    execute: (input, caller) => runProbeDaemon(input, caller, registry),
  });
}
