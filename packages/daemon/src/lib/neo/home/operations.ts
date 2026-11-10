import { neoToolDescription } from '@hyperneo/prompts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { isLocalUser } from '../../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import { neoFolderPath } from '../folder.ts';
import type { NeoService } from '../service.ts';
import { requireHomeConfirmation } from './confirmation.ts';
import { reportHomeConflict, requireHomeChoice } from './conflicts.ts';
import { HomeReadInput, HomeReadResult } from './read.ts';
import { type HomeResult, NeoHomeRepository } from './repository.ts';
import { HomeSaveInput, HomeSaveResult, requireHomePath } from './save.ts';

export function createNeoHomeOperations(
  service: Pick<NeoService, 'repo' | 'todos' | 'defaultSessionId'>,
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
    .pipe(
      (input: { remoteUrl?: string }, caller: OperationCaller) =>
        input.remoteUrl && !isLocalUser(caller)
          ? {
              reason: {
                ok: false,
                reason: 'human_selection_required: ask the local user to select the home remote.',
              },
            }
          : { value: input },
      ['input', 'caller'],
      'result:outcome'
    )
    .pipe((input: { remoteUrl?: string }) => home.init(input.remoteUrl), 'outcome', 'outcome')
    .endAsync('outcome') as (input: unknown, caller: OperationCaller) => Promise<HomeResult>;
  const save = (superpipe({})('neo.home.save') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(owner, 'caller', 'result:outcome')
    .pipe(requireHomePath, 'input', 'result:outcome')
    .pipe(
      (input: HomeSaveInput) =>
        requireHomeConfirmation(input, service.todos, service.defaultSessionId()),
      'outcome',
      'result:outcome'
    )
    .pipe(
      (input) => requireHomeChoice(input, service.todos, service.defaultSessionId(), home.root),
      'outcome',
      'result:outcome'
    )
    .pipe((input) => home.save(input), 'outcome', 'outcome')
    .pipe(
      (result) => reportHomeConflict(result, service.todos, service.defaultSessionId()),
      'outcome',
      'outcome'
    )
    .endAsync('outcome') as (
    input: HomeSaveInput,
    caller: OperationCaller
  ) => Promise<HomeSaveResult>;
  const read = (superpipe({})('neo.home.read') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(owner, 'caller', 'result:outcome')
    .pipe(requireHomePath, 'input', 'result:outcome')
    .pipe((input: HomeReadInput) => home.read(input), 'outcome', 'outcome')
    .pipe(
      (result) => reportHomeConflict(result, service.todos, service.defaultSessionId()),
      'outcome',
      'outcome'
    )
    .endAsync('outcome') as (
    input: HomeReadInput,
    caller: OperationCaller
  ) => Promise<HomeReadResult>;
  return [
    defineOperation({
      name: 'neo.home.read',
      description: neoToolDescription('neo.home.read'),
      inputSchema: HomeReadInput,
      resultSchema: HomeReadResult,
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: (input, caller) => read(input, caller),
    }),
    defineOperation({
      name: 'neo.home.save',
      description: neoToolDescription('neo.home.save'),
      inputSchema: HomeSaveInput,
      resultSchema: HomeSaveResult,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: (input, caller) => save(input, caller),
    }),
    defineOperation({
      name: 'neo.home.init',
      description: neoToolDescription('neo.home.init'),
      inputSchema: z.object({ remoteUrl: z.string().trim().min(1).optional() }),
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
