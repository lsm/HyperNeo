import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { isLocalUser } from '../../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import { neoFolderPath } from '../folder.ts';
import type { NeoService } from '../service.ts';
import { NeoHomeRepository, type HomeResult } from './repository.ts';
import { HomeReadInput, HomeReadResult } from './read.ts';
import { HomeSaveInput, HomeSaveResult, requireHomePath, requireHomeSave } from './save.ts';

export function createNeoHomeOperations(
  service: Pick<NeoService, 'repo' | 'defaultSessionId'>,
  home = new NeoHomeRepository(neoFolderPath(), service.repo)
) {
  const owner = (caller: OperationCaller) =>
    isLocalUser(caller) ||
    (caller.source === 'mcp' &&
      !!caller.sessionId &&
      caller.sessionId === service.defaultSessionId())
      ? { value: caller }
      : { reason: { ok: false, reason: 'This operation belongs to root Neo or the user.' } };
  const init = (superpipe({})('neo.home.init') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(owner, 'caller', 'result:outcome')
    .pipe(() => home.init(), 'outcome', 'outcome')
    .endAsync('outcome') as (input: unknown, caller: OperationCaller) => Promise<HomeResult>;
  const save = (superpipe({})('neo.home.save') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(owner, 'caller', 'result:outcome')
    .pipe(requireHomePath, 'input', 'result:outcome')
    .pipe(requireHomeSave, 'outcome', 'result:outcome')
    .pipe((input: HomeSaveInput) => home.save(input), 'outcome', 'outcome')
    .endAsync('outcome') as (
    input: HomeSaveInput,
    caller: OperationCaller
  ) => Promise<HomeSaveResult>;
  const read = (superpipe({})('neo.home.read') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(owner, 'caller', 'result:outcome')
    .pipe(requireHomePath, 'input', 'result:outcome')
    .pipe((input: HomeReadInput) => home.read(input), 'outcome', 'outcome')
    .endAsync('outcome') as (
    input: HomeReadInput,
    caller: OperationCaller
  ) => Promise<HomeReadResult>;
  return [
    defineOperation({
      name: 'neo.home.read',
      description:
        'Read a complete local curated home document and its SHA-256, including human edits. Never initializes or commits. Refuses internal, ignored or symlink paths and non-UTF-8 content. Root Neo or the local user only.',
      inputSchema: HomeReadInput,
      resultSchema: HomeReadResult,
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: (input, caller) => read(input, caller),
    }),
    defineOperation({
      name: 'neo.home.save',
      description:
        'Save one curated document and commit locally. Refuses credential-like content, internal/ignored paths and dirty home changes. Direction and mandate require later confirmation support. Root Neo or the local user only; direct filesystem access requires an environment boundary.',
      inputSchema: HomeSaveInput,
      resultSchema: HomeSaveResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: (input, caller) => save(input, caller),
    }),
    defineOperation({
      name: 'neo.home.init',
      description:
        'Initialize the local Neo home repository, ignore coordinator transcripts, and assign stable project folders. Uses the configured git identity; fix identity/signing configuration and retry if commit fails. Root Neo or the local user only.',
      inputSchema: z.object({}),
      resultSchema: z.union([
        z.object({ ok: z.literal(false), reason: z.string() }),
        z.object({
          ok: z.literal(true),
          path: z.string(),
          projects: z.array(z.object({ id: z.string(), homePath: z.string() })),
        }),
      ]),
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: (input, caller) => init(input, caller),
    }),
  ];
}
