import { hostname } from 'node:os';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { BUILD_METADATA, UNKNOWN_VERSION } from '../build-metadata.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { remoteDaemons, type RemoteDaemonRegistry } from './registry.ts';

const REMOTE_BUILD_TIMEOUT_MS = 5000;

export const DaemonBuildInputSchema = z
  .object({ remotes: z.boolean().default(true) })
  .strict()
  .default({ remotes: true });

const DaemonBuildSchema = z.object({
  daemonId: z.string(),
  self: z.boolean(),
  version: z.string().nullable(),
  commit: z.string().nullable(),
  reason: z.string().optional(),
});

export const DaemonBuildResultSchema = z.union([
  z.object({ kind: z.literal('read'), daemons: z.array(DaemonBuildSchema) }),
  z.object({ kind: z.literal('rejected'), reason: z.string() }),
]);

export type DaemonBuild = z.infer<typeof DaemonBuildSchema>;
type BuildInput = z.infer<typeof DaemonBuildInputSchema>;
type BuildResult = z.infer<typeof DaemonBuildResultSchema>;

export interface DaemonBuildDeps {
  self: { name: string; version: string; commit: string };
  registry: Pick<RemoteDaemonRegistry, 'list' | 'invoke'>;
}

const known = (value: string) => (value && value !== UNKNOWN_VERSION ? value : null);

export function selfDaemonBuild(self: DaemonBuildDeps['self']): DaemonBuild {
  return {
    daemonId: self.name,
    self: true,
    version: known(self.version),
    commit: known(self.commit),
  };
}

export function presentRemoteDaemonBuild(daemonId: string, reply: unknown): DaemonBuild {
  const parsed = DaemonBuildResultSchema.safeParse(reply);
  const own =
    parsed.success && parsed.data.kind === 'read'
      ? parsed.data.daemons.find((daemon) => daemon.self)
      : undefined;
  return own
    ? { daemonId, self: false, version: own.version, commit: own.commit }
    : {
        daemonId,
        self: false,
        version: null,
        commit: null,
        reason:
          parsed.success && parsed.data.kind === 'rejected'
            ? parsed.data.reason
            : 'unreadable: the daemon answered without its build',
      };
}

export async function readKnownDaemonBuilds(
  deps: DaemonBuildDeps,
  remotes = true
): Promise<DaemonBuild[]> {
  const others = remotes ? deps.registry.list() : [];
  const read = await Promise.all(
    others.map(({ daemonId }) =>
      deps.registry
        .invoke(
          daemonId,
          'daemon.build',
          { remotes: false },
          { timeoutMs: REMOTE_BUILD_TIMEOUT_MS }
        )
        .then(
          (reply) => presentRemoteDaemonBuild(daemonId, reply),
          (error: unknown): DaemonBuild => ({
            daemonId,
            self: false,
            version: null,
            commit: null,
            reason: `unreachable: ${error instanceof Error ? error.message : String(error)}`,
          })
        )
    )
  );
  return [selfDaemonBuild(deps.self), ...read];
}

export const defaultDaemonBuildDeps: DaemonBuildDeps = {
  self: { name: hostname(), version: BUILD_METADATA.version, commit: BUILD_METADATA.commit },
  registry: remoteDaemons,
};

function admitBuildCaller(
  input: BuildInput,
  caller: OperationCaller
): { value: BuildInput } | { reason: BuildResult } {
  return caller.source === 'rpc' || caller.role === 'neo'
    ? { value: input }
    : { reason: { kind: 'rejected', reason: 'daemon_build_forbidden' } };
}

export function createDaemonBuildOperation(deps: DaemonBuildDeps = defaultDaemonBuildDeps) {
  const read = (superpipe({})('daemon-build') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitBuildCaller, ['input', 'caller'], 'result:outcome')
    .pipe(
      async (input: BuildInput) => ({
        kind: 'read' as const,
        daemons: await readKnownDaemonBuilds(deps, input.remotes),
      }),
      'outcome',
      'outcome'
    )
    .endAsync('outcome') as (input: BuildInput, caller: OperationCaller) => Promise<BuildResult>;
  return defineOperation({
    name: 'daemon.build',
    policy: { safetyClass: 'read', roles: ['neo'] },
    description:
      'Read which commit each HyperNeo daemon this daemon knows is running: this daemon (self, named by its host) and every attached remote daemon, read live over its connection. commit is null when a daemon cannot be read or does not know its build, with the reason. remotes: false reads this daemon only. Available to RPC callers and Neo.',
    inputSchema: DaemonBuildInputSchema,
    resultSchema: DaemonBuildResultSchema,
    execute: read,
  });
}
