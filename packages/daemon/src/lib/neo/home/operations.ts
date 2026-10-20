import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { isLocalUser } from '../../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import { neoFolderPath } from '../folder.ts';
import type { NeoService } from '../service.ts';
import { NeoHomeRepository, type HomeResult } from './repository.ts';

export function createNeoHomeOperations(
  service: Pick<NeoService, 'repo' | 'defaultSessionId'>,
  home = new NeoHomeRepository(neoFolderPath(), service.repo)
) {
  const init = (superpipe({})('neo.home.init') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) =>
        isLocalUser(caller) ||
        (caller.source === 'mcp' &&
          !!caller.sessionId &&
          caller.sessionId === service.defaultSessionId())
          ? { value: caller }
          : { reason: { ok: false, reason: 'This operation belongs to root Neo or the user.' } },
      'caller',
      'result:outcome'
    )
    .pipe(() => home.init(), 'outcome', 'outcome')
    .endAsync('outcome') as (input: unknown, caller: OperationCaller) => Promise<HomeResult>;
  return [
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
