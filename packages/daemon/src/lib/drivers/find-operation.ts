import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation } from '../operations/registry.ts';
import { mergePlaceGroups, stampDaemon } from './places.ts';
import { PlaceGroupSchema, type FindQuery, type PlaceGroup, type WorkAdapter } from './types.ts';

export const FindWorkInputSchema = z.object({
  text: z.string().trim().min(1).max(200).optional(),
  folder: z.string().min(1).optional(),
  spaceId: z.string().min(1).optional(),
  adapters: z.array(z.string().min(1)).optional(),
  includeClosed: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(20),
  localOnly: z.boolean().default(false),
});

export const FindWorkResultSchema = z.object({
  places: z.array(PlaceGroupSchema),
  unreachable: z.array(z.object({ source: z.string(), reason: z.string() })),
});

type FindInput = z.infer<typeof FindWorkInputSchema>;
type FindResult = z.infer<typeof FindWorkResultSchema>;
type SourceOutcome = { groups: PlaceGroup[]; unreachable: FindResult['unreachable'] };

export interface RemoteDaemons {
  list(): { daemonId: string }[];
  invoke(
    daemonId: string,
    name: string,
    input: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown>;
}

export interface FindWorkDeps {
  adapters(): readonly WorkAdapter[];
  remote: RemoteDaemons;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function selectFindAdapters(input: FindInput, deps: FindWorkDeps): WorkAdapter[] {
  return deps
    .adapters()
    .filter(
      (adapter) =>
        adapter.capabilities.includes('find') &&
        (!input.adapters || input.adapters.includes(adapter.id))
    );
}

export function toFindQuery(input: FindInput): FindQuery {
  return {
    text: input.text,
    folder: input.folder,
    spaceId: input.spaceId,
    includeClosed: input.includeClosed,
    limit: input.limit,
  };
}

export async function findLocally(
  adapters: readonly WorkAdapter[],
  query: FindQuery
): Promise<SourceOutcome> {
  const settled = await Promise.allSettled(adapters.map(async (adapter) => adapter.find(query)));
  return settled.reduce<SourceOutcome>(
    (outcome, result, index) =>
      result.status === 'fulfilled'
        ? { ...outcome, groups: [...outcome.groups, ...result.value] }
        : {
            ...outcome,
            unreachable: [
              ...outcome.unreachable,
              { source: adapters[index].id, reason: describe(result.reason) },
            ],
          },
    { groups: [], unreachable: [] }
  );
}

async function findOnDaemon(
  daemonId: string,
  input: FindInput,
  deps: FindWorkDeps
): Promise<SourceOutcome> {
  const reply = FindWorkResultSchema.safeParse(
    await deps.remote.invoke(daemonId, 'work.find', { ...input, localOnly: true })
  );
  if (!reply.success) throw new Error('unusable work.find reply');
  return {
    groups: stampDaemon(reply.data.places, daemonId),
    unreachable: reply.data.unreachable.map(({ source, reason }) => ({
      source: `${daemonId}/${source}`,
      reason,
    })),
  };
}

export async function findRemotely(input: FindInput, deps: FindWorkDeps): Promise<SourceOutcome> {
  if (input.localOnly) return { groups: [], unreachable: [] };
  const daemons = deps.remote.list();
  const settled = await Promise.allSettled(
    daemons.map(({ daemonId }) => findOnDaemon(daemonId, input, deps))
  );
  return settled.reduce<SourceOutcome>(
    (outcome, result, index) =>
      result.status === 'fulfilled'
        ? {
            groups: [...outcome.groups, ...result.value.groups],
            unreachable: [...outcome.unreachable, ...result.value.unreachable],
          }
        : {
            ...outcome,
            unreachable: [
              ...outcome.unreachable,
              { source: daemons[index].daemonId, reason: describe(result.reason) },
            ],
          },
    { groups: [], unreachable: [] }
  );
}

export function combineFindResults(
  local: SourceOutcome,
  remote: SourceOutcome,
  input: FindInput
): FindResult {
  return {
    places: mergePlaceGroups([...local.groups, ...remote.groups], input.limit),
    unreachable: [...local.unreachable, ...remote.unreachable],
  };
}

const runFindWork = (superpipe({})('find-work') as PipelineAPI)
  .input(['input', 'deps'])
  .pipe(selectFindAdapters, ['input', 'deps'], 'adapters')
  .pipe(toFindQuery, 'input', 'query')
  .pipe(findLocally, ['adapters', 'query'], 'local')
  .pipe(findRemotely, ['input', 'deps'], 'remote')
  .pipe(combineFindResults, ['local', 'remote', 'input'], 'result')
  .endAsync('result') as (input: FindInput, deps: FindWorkDeps) => Promise<FindResult>;

export function createFindWorkOperation(deps: FindWorkDeps) {
  return defineOperation({
    name: 'work.find',
    description:
      'Find open work and the places it lives, on this daemon and every attached daemon. Returns places (project folders, Spaces) most recent first, each with its open sessions, threads, tasks or Space agents; a place is returned even when nothing in it is open, so this is also the project list. With text, it matches place names, work titles and message content. includeClosed adds ended and archived work. A daemon or adapter that cannot answer is listed under unreachable instead of failing the search.',
    inputSchema: FindWorkInputSchema,
    resultSchema: FindWorkResultSchema,
    policy: { safetyClass: 'read' },
    execute: (input) => runFindWork(input, deps),
  });
}
