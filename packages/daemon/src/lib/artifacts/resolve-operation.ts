import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/sqlite-compat.ts';
import { ArtifactFileRepository } from '../../storage/repositories/artifact-file-repository.ts';
import { ArtifactReferenceSourceRepository } from '../../storage/repositories/artifact-reference-source.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { isLocalUser } from '../operations/caller.ts';
import { getDataDir } from '../data-dir.ts';
import { ArtifactRefSchema, ArtifactRefusalSchema } from './file-contracts.ts';
import { createArtifactRegistration } from './register-operation.ts';
import { planStoredReference } from './reference-plan.ts';

const context = z.strictObject({ kind: z.enum(['todo', 'ask']), id: z.string().min(1).max(200) });
const inputSchema = z.strictObject({
  sourceMessageOrCard: z.strictObject({
    kind: z.enum(['message', 'publication', 'todo']),
    id: z.string().min(1).max(200),
    revisionId: z.string().min(1).max(200).optional(),
  }),
  reference: z.string().min(1).max(4096),
  context: context.optional(),
  requestId: z
    .string()
    .uuid()
    .default(() => randomUUID()),
});
type Input = z.infer<typeof inputSchema>;
const unavailable = () => ({ accepted: false as const, reason: 'unavailable' as const });

export function createArtifactReferenceResolve(
  database: () => Database,
  data = getDataDir(),
  home = homedir(),
  capture = createArtifactRegistration(database, data, home).execute
) {
  async function plan(input: Input, caller: OperationCaller) {
    const db = database();
    const daemonId = new ArtifactFileRepository(db).daemonId;
    const sources = new ArtifactReferenceSourceRepository(db, daemonId);
    return planStoredReference(
      { source: input.sourceMessageOrCard, reference: input.reference, context: input.context },
      caller,
      {
        daemonId,
        home,
        loadSource: async (key) => sources.load(key),
      }
    );
  }
  async function prepare(input: Input, caller: OperationCaller) {
    const result = await plan(input, caller);
    if (!result.accepted) return { reason: result };
    return result.kind === 'worktree'
      ? { value: result }
      : { reason: { accepted: false as const, reason: 'unsupported_type' } };
  }
  type Plan = Extract<Awaited<ReturnType<typeof prepare>>, { value: unknown }>['value'];
  async function snapshot(selected: Plan, input: Input, caller: OperationCaller) {
    const result = (await capture(
      {
        requestId: input.requestId,
        context: selected.context,
        path: join(selected.root, selected.relativePath),
        title: selected.relativePath.split('/').at(-1)!.slice(0, 200),
      },
      caller
    )) as { accepted: boolean; reason?: string };
    const current = await plan(input, caller);
    if (JSON.stringify(current) !== JSON.stringify(selected)) return unavailable();
    return !result.accepted && result.reason === 'unsafe_path' ? unavailable() : result;
  }
  const resolve = (superpipe({})('artifact-reference-resolve') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) =>
        isLocalUser(caller) ? { value: caller } : { reason: unavailable() },
      'caller',
      'result:resolved'
    )
    .pipe(prepare, ['input', 'resolved'], 'result:resolved')
    .pipe(snapshot, ['resolved', 'input', 'caller'], 'resolved')
    .endAsync('resolved') as (input: Input, caller: OperationCaller) => Promise<unknown>;
  return defineOperation({
    name: 'artifact.reference.resolve',
    description:
      'Paired-human tap: resolve an exact reference from a stored message/publication/todo and snapshot a local bound file. Optional context chooses only among the source’s authorized bindings. No raw-path grants, GitHub/Git reads or agent invocation. Reads use anchored no-follow descriptors and immutable registered snapshots.',
    inputSchema,
    resultSchema: z.union([
      ArtifactRefusalSchema,
      z.strictObject({
        accepted: z.literal(false),
        reason: z.literal('owning_daemon_unavailable'),
      }),
      z.strictObject({
        accepted: z.literal(false),
        reason: z.literal('ambiguous_context'),
        choices: z.array(context).max(100),
      }),
      z.strictObject({
        accepted: z.literal(false),
        reason: z.literal('size_limit'),
        actualBytes: z.number().int().nonnegative(),
        limitBytes: z.number().int().positive(),
      }),
      z.strictObject({ accepted: z.literal(true), artifact: ArtifactRefSchema }),
    ]),
    policy: { safetyClass: 'mutate' },
    execute: resolve,
  });
}
