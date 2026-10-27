import { WorkerIdentitySchema } from './worker-identity-schema.ts';
import { workerIdentity } from '@hyperneo/shared/types/worker-identity';
import { runLagPhase } from '../event-loop-activity.ts';
import { basename, isAbsolute, join, normalize } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation } from '../operations/registry.ts';
import { readWorkspaceIdentity, identifyWorkspaces } from './code-identity.ts';
import { mergePlaceGroups, placeKey, stampDaemon } from './places.ts';
import type { OperationCaller } from '../operations/registry.ts';
import {
  PlaceGroupSchema,
  WorkRefSchema,
  type FindQuery,
  type PlaceGroup,
  type WorkAdapter,
} from './types.ts';

export const FindWorkInputSchema = z.object({
  idPrefix: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Find HyperNeo sessions or Codex threads by ID prefix, before history limits. Multiple matches remain explicit.'
    ),
  text: z.string().trim().min(1).max(200).optional(),
  id: z.string().trim().min(1).max(200).optional(),
  session: z.string().trim().min(1).max(200).optional(),
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
  more: z.boolean().optional(),
  session: z
    .object({
      name: z.string(),
      match: z.enum(['exact', 'ambiguous', 'none']),
      near: z
        .array(
          z.object({
            ref: WorkRefSchema,
            title: z.string(),
            worker: WorkerIdentitySchema.optional(),
          })
        )
        .optional(),
    })
    .optional(),
});

export const FIND_RESULT_BUDGET_CHARS = 60_000;
export const FIND_AGENT_RESULT_BUDGET_CHARS = 16_000;
const TITLE_BUDGET_CHARS = 200;

type FindInput = z.infer<typeof FindWorkInputSchema>;
type FindResult = z.infer<typeof FindWorkResultSchema>;
type SourceOutcome = {
  groups: PlaceGroup[];
  unreachable: FindResult['unreachable'];
  more?: boolean;
};

export interface RemoteDaemons {
  list(): { daemonId: string }[];
  invoke(
    daemonId: string,
    name: string,
    input: unknown,
    options?: { timeoutMs?: number }
  ): Promise<unknown>;
}

export interface NamedFolderDeps {
  machine: string;
  homeDir: string;
  isDirectory(folder: string): boolean;
}

export interface FindWorkDeps {
  adapters(): readonly WorkAdapter[];
  remote: RemoteDaemons;
  mirrorProjects?(groups: readonly PlaceGroup[]): void | Promise<void>;
  namedFolder?: NamedFolderDeps;
  ownPlaces?(caller: OperationCaller): ReadonlySet<string>;
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
        (!input.idPrefix || ['hyperneo', 'codex-desktop'].includes(adapter.id)) &&
        (!input.adapters || input.adapters.includes(adapter.id))
    );
}

export function toFindQuery(input: FindInput): FindQuery {
  return input.id
    ? { folder: input.folder, spaceId: input.spaceId, includeClosed: true, limit: 50 }
    : {
        ...(input.idPrefix ? { idPrefix: input.idPrefix } : {}),
        text: input.text,
        folder: input.folder,
        spaceId: input.spaceId,
        includeClosed: input.includeClosed,
        limit: input.session ? 50 : input.limit,
      };
}

export function expandFindFolder(input: FindInput, deps: FindWorkDeps): FindInput {
  const folder = input.folder?.trim();
  const homeDir = deps.namedFolder?.homeDir;
  if (!folder || !homeDir) return input;
  const expanded =
    folder === '~' ? homeDir : folder.startsWith('~/') ? join(homeDir, folder.slice(2)) : folder;
  return isAbsolute(expanded)
    ? { ...input, folder: normalize(expanded).replace(/(.)\/+$/, '$1') }
    : input;
}

export function readNamedFolder(input: FindInput, deps: FindWorkDeps): { folder?: string } {
  const { folder } = input;
  if (input.id || !folder || !isAbsolute(folder) || !deps.namedFolder) return {};
  return deps.namedFolder.isDirectory(folder) ? { folder } : {};
}

export function addNamedPlace(
  local: SourceOutcome,
  named: { folder?: string },
  deps: FindWorkDeps
): SourceOutcome {
  const { folder } = named;
  const machine = deps.namedFolder?.machine;
  const known = local.groups.some((group) =>
    [group.place, ...(group.workspaces ?? [])].some((place) => place.folder === folder)
  );
  if (!folder || !machine || known) return local;
  return {
    ...local,
    groups: [
      ...local.groups,
      {
        place: { machine, folder, name: basename(folder) },
        lastActivityAt: 0,
        openCount: 0,
        archivedCount: 0,
        adapters: [],
        work: [],
      },
    ],
  };
}

const sessionName = (title: string) => title.trim().replace(/\s+/g, ' ').toLowerCase();
const NEAR_SESSIONS = 5;

export function searchFindSession(input: FindInput): FindInput {
  return input.session ? { ...input, text: input.session } : input;
}

export function keepFindSession(
  groups: readonly PlaceGroup[],
  session: string | undefined
): PlaceGroup[] {
  if (!session) return [...groups];
  const name = sessionName(session);
  return groups.flatMap((group) => {
    const work = group.work.filter((item) => sessionName(item.title) === name);
    return work.length ? [{ ...group, work }] : [];
  });
}

export function findSessionVerdict(
  session: string,
  matched: readonly PlaceGroup[],
  searched: readonly PlaceGroup[]
): NonNullable<FindResult['session']> {
  const count = matched.reduce((total, group) => total + group.work.length, 0);
  if (count) return { name: session, match: count === 1 ? 'exact' : 'ambiguous' };
  const near = searched
    .flatMap((group) =>
      group.work.map(({ ref, title, worker }) => ({
        ref,
        title,
        worker: worker ?? workerIdentity(ref, title),
      }))
    )
    .slice(0, NEAR_SESSIONS);
  return { name: session, match: 'none', near };
}

export function keepFindId(groups: readonly PlaceGroup[], id: string | undefined): PlaceGroup[] {
  if (!id) return [...groups];
  return groups.flatMap((group) => {
    const work = group.work.filter((item) => item.ref.id === id);
    return work.length ? [{ ...group, work }] : [];
  });
}

export async function findLocally(
  adapters: readonly WorkAdapter[],
  query: FindQuery
): Promise<SourceOutcome> {
  const settled = await Promise.allSettled(
    adapters.map(async (adapter) =>
      runLagPhase(`work:find:${adapter.id}`, async () => {
        const groups = await adapter.find(query);
        if (adapter.id !== 'claude-code') return groups;
        return Promise.all(
          groups.map(async (group) => ({
            ...group,
            work: await Promise.all(
              group.work.map(async (work) => {
                const current = await adapter.status?.(work.ref);
                return {
                  ...work,
                  title: current?.ok ? current.value.title : work.title,
                  worker: workerIdentity(work.ref, current?.ok ? current.value.title : null),
                };
              })
            ),
          }))
        );
      })
    )
  );
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
    more: reply.data.more === true,
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
            more: outcome.more === true || result.value.more === true,
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

export function askRemotely(
  input: FindInput,
  deps: FindWorkDeps
): { pending: Promise<SourceOutcome> } {
  return { pending: findRemotely(input, deps) };
}

function clampTitle(work: PlaceGroup['work'][number]): PlaceGroup['work'][number] {
  const title =
    work.title.length > TITLE_BUDGET_CHARS
      ? `${work.title.slice(0, TITLE_BUDGET_CHARS)}…`
      : work.title;
  return { ...work, title, worker: work.worker ?? workerIdentity(work.ref, title) };
}

export function fitFindBudget(
  places: readonly PlaceGroup[],
  budget: number
): { places: PlaceGroup[]; more: boolean } {
  const kept: PlaceGroup[] = [];
  let used = 0;
  let more = false;
  for (const group of places) {
    const shell = { ...group, work: [] };
    const shellSize = JSON.stringify(shell).length;
    if (used + shellSize > budget) {
      more = true;
      break;
    }
    used += shellSize;
    const work: PlaceGroup['work'] = [];
    for (const item of group.work.map(clampTitle)) {
      const size = JSON.stringify(item).length + 1;
      if (used + size > budget) {
        more = true;
        break;
      }
      used += size;
      work.push(item);
    }
    kept.push({ ...shell, work });
    if (more) break;
  }
  return { places: kept, more };
}

export function ownPlacesFirst(
  groups: readonly PlaceGroup[],
  own: ReadonlySet<string>
): PlaceGroup[] {
  const mine = (group: PlaceGroup) =>
    (group.workspaces ?? [group.place]).some((place) => own.has(placeKey(place)));
  return [...groups.filter(mine), ...groups.filter((group) => !mine(group))];
}

export function combineFindResults(
  local: SourceOutcome,
  remote: SourceOutcome,
  input: FindInput,
  budget = FIND_RESULT_BUDGET_CHARS,
  own: ReadonlySet<string> = new Set()
): FindResult {
  const searched = ownPlacesFirst(
    mergePlaceGroups([...local.groups, ...remote.groups], Number.MAX_SAFE_INTEGER),
    input.id ? new Set() : own
  );
  const named = keepFindSession(searched, input.session);
  const merged = keepFindId(
    named.slice(0, input.id || input.session ? 51 : input.limit + 1),
    input.id
  );
  const open =
    input.includeClosed || input.id
      ? merged
      : merged.map((group) => ({
          ...group,
          work: group.work.filter((work) => work.status !== 'stopped'),
        }));
  const fitted = fitFindBudget(open.slice(0, input.session ? 51 : input.limit), budget);
  return {
    places: fitted.places,
    unreachable: [...local.unreachable, ...remote.unreachable],
    more: fitted.more || remote.more === true || merged.length > input.limit,
    ...(input.session ? { session: findSessionVerdict(input.session, open, searched) } : {}),
  };
}

const runFindWork = (superpipe({})('find-work') as PipelineAPI)
  .input(['input', 'deps', 'budget', 'own'])
  .pipe(searchFindSession, 'input', 'input')
  .pipe(selectFindAdapters, ['input', 'deps'], 'adapters')
  .pipe(askRemotely, ['input', 'deps'], 'asked')
  .pipe(expandFindFolder, ['input', 'deps'], 'input')
  .pipe(toFindQuery, 'input', 'query')
  .pipe(readNamedFolder, ['input', 'deps'], 'named')
  .pipe(findLocally, ['adapters', 'query'], 'local')
  .pipe(addNamedPlace, ['local', 'named', 'deps'], 'local')
  .pipe(
    async (local: SourceOutcome, input: FindInput) => ({
      ...local,
      groups: await identifyWorkspaces(local.groups, (folder) =>
        readWorkspaceIdentity(folder, input.folder === folder)
      ),
    }),
    ['local', 'input'],
    'local'
  )
  .pipe((asked: { pending: Promise<SourceOutcome> }) => asked.pending, 'asked', 'remote')
  .pipe(combineFindResults, ['local', 'remote', 'input', 'budget', 'own'], 'result')
  .pipe(
    async (result: FindResult, deps: FindWorkDeps) => {
      await deps.mirrorProjects?.(result.places);
      return result;
    },
    ['result', 'deps'],
    'result'
  )
  .endAsync('result') as (
  input: FindInput,
  deps: FindWorkDeps,
  budget: number,
  own: ReadonlySet<string>
) => Promise<FindResult>;

export function createFindWorkOperation(deps: FindWorkDeps) {
  return defineOperation({
    name: 'work.find',
    description:
      'Find open work and the places it lives, on this daemon and every attached daemon. Returns places (project folders, Spaces) most recent first, the calling Neo project’s own folders ahead of the rest, each with its open sessions, threads, tasks or Space agents; a place is returned even when nothing in it is open, so this is also the project list. With text, it matches place names, work titles and message content. With id, it returns only the work whose ref id matches, closed or not, for example to turn a session id into its ref and place; id takes precedence over text, which is then ignored. With session, the name of a session the human named, it returns only work whose title equals that name exactly (case and spacing aside) and says whether the match is exact, ambiguous (every candidate is listed) or none (near lists the closest titles); send only to an exact match, and tell the human the candidates or the miss instead of picking one. The lookup covers the 50 most recent places and each place’s most recent work, so a long-idle item may not be found. includeClosed adds ended and archived work. A daemon or adapter that cannot answer is listed under unreachable instead of failing the search. The reply is size-bounded: more is true when places or work were left out, so narrow with text, folder or spaceId. folder takes a path as the human wrote it (~ allowed); an existing directory there is returned as a place even when no work has run in it yet, so a folder the human names can always be started in. Snippet handles are for work.read only; to send or propose work, use the item ref.',
    inputSchema: FindWorkInputSchema,
    resultSchema: FindWorkResultSchema,
    policy: { safetyClass: 'read' },
    execute: (input, caller) =>
      runFindWork(
        input,
        deps,
        caller.source === 'mcp' ? FIND_AGENT_RESULT_BUDGET_CHARS : FIND_RESULT_BUDGET_CHARS,
        deps.ownPlaces?.(caller) ?? new Set()
      ),
  });
}
