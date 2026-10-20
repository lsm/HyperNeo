import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { isLocalUser } from '../../operations/caller.ts';
import { defineOperation, type OperationCaller } from '../../operations/registry.ts';
import { neoFolderPath } from '../folder.ts';
import type { NeoService } from '../service.ts';
import {
  NeoHomeRepository,
  requireHomeContent,
  requireHomePath,
  type HomeGate,
  type HomeResult,
} from './repository.ts';

const ByPath = z.object({ path: z.string().min(1) });
const Save = ByPath.extend({ content: z.string(), message: z.string().trim().min(1).max(2000) });
const Result = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({ ok: z.literal(true), path: z.string() }).passthrough(),
]);

export function createNeoHomeOperations(
  service: Pick<NeoService, 'repo' | 'defaultSessionId'>,
  home = new NeoHomeRepository(neoFolderPath(), service.repo)
) {
  const path = (name: string) =>
    (superpipe({})(name) as PipelineAPI)
      .input(['input', 'caller'])
      .pipe(
        (caller: OperationCaller): HomeGate<OperationCaller> =>
          isLocalUser(caller) ||
          (caller.source === 'mcp' &&
            !!caller.sessionId &&
            caller.sessionId === service.defaultSessionId())
            ? { value: caller }
            : { reason: { ok: false, reason: 'This operation belongs to root Neo or the user.' } },
        'caller',
        'result:outcome'
      );
  const document = <T extends { path: string }>(input: T): HomeGate<T> => {
    const gate = requireHomePath(input.path);
    return 'reason' in gate ? gate : { value: input };
  };
  const init = path('neo.home.init')
    .pipe(() => home.init(), 'outcome', 'outcome')
    .endAsync('outcome');
  const read = path('neo.home.read')
    .pipe(document, 'input', 'result:outcome')
    .pipe((input: z.infer<typeof ByPath>) => home.read(input.path), 'outcome', 'outcome')
    .endAsync('outcome');
  const save = path('neo.home.save')
    .pipe(document, 'input', 'result:outcome')
    .pipe(requireHomeContent, 'outcome', 'result:outcome')
    .pipe((input: z.infer<typeof Save>) => home.save(input), 'outcome', 'outcome')
    .endAsync('outcome');
  type Run = (input: unknown, caller: OperationCaller) => Promise<HomeResult>;
  return [
    defineOperation({
      name: 'neo.home.init',
      description:
        'Initialize the local Neo home git repository, ignore raw coordinator transcripts, and assign stable project home paths. Root Neo or the user only.',
      inputSchema: z.object({}),
      resultSchema: Result,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: (input, caller) => (init as Run)(input, caller),
    }),
    defineOperation({
      name: 'neo.home.read',
      description:
        'Read a curated document by relative path in the Neo home repository. Hidden, ignored and symlinked paths are refused.',
      inputSchema: ByPath,
      resultSchema: Result,
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: (input, caller) => (read as Run)(input, caller),
    }),
    defineOperation({
      name: 'neo.home.save',
      description:
        'Save and locally commit one curated home document. Refuses dirty repositories, hidden/ignored paths and secret content. Direction and mandate changes require human confirmation; this gate is not available until H2.',
      inputSchema: Save,
      resultSchema: Result,
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: (input, caller) => (save as Run)(input, caller),
    }),
  ];
}
