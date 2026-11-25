import { neoToolDescription } from '@hyperneo/prompts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { NEO_INBOX_ID } from './inbox.ts';
import { requireNeoTreeAuthor } from './project-author.ts';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';

type ForgetRepo = Pick<NeoRepository, 'allRepositories' | 'forgetProject' | 'getBindingBySession'>;
type Refusal = 'project_missing' | 'project_in_use' | 'project_protected' | 'root_or_human_only';
type ForgetRepositories = (repos: readonly string[]) => void;
type Forgotten = { ok: true; repos: string[] } | { ok: false; reason: Refusal };
type ForgetSuccess = Extract<Forgotten, { ok: true }>;

const Input = z.object({
  projectId: z.string().min(1).max(100),
  removeHistory: z.boolean().default(false),
});

const Result = z.union([
  z.object({ ok: z.literal(true), repos: z.array(z.string()) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      'project_missing',
      'project_in_use',
      'project_protected',
      'root_or_human_only',
    ]),
  }),
]);

export const runNeoProjectForgetTransaction = (
  superpipe({})('neo.project.forget.transaction') as PipelineAPI
)
  .input(['projectId', 'caller', 'repo', 'forgetRepositories', 'removeHistory'])
  .pipe(
    (caller: OperationCaller, repo: ForgetRepo) =>
      requireNeoTreeAuthor(
        caller,
        caller.sessionId ? repo.getBindingBySession(caller.sessionId) : null
      ),
    ['caller', 'repo'],
    'result:outcome'
  )
  .pipe(
    (removeHistory: boolean, caller: OperationCaller) =>
      !removeHistory || (caller.source === 'rpc' && caller.principal === 'local')
        ? { value: true }
        : { reason: { ok: false as const, reason: 'root_or_human_only' as const } },
    ['removeHistory', 'caller'],
    'result:outcome'
  )
  .pipe(
    (projectId: string) =>
      projectId === NEO_INBOX_ID
        ? { reason: { ok: false as const, reason: 'project_protected' as const } }
        : { value: true },
    'projectId',
    'result:outcome'
  )
  .pipe(
    (projectId: string, repo: ForgetRepo) => repo.allRepositories(projectId),
    ['projectId', 'repo'],
    'repos'
  )
  .pipe(
    (
      projectId: string,
      repo: ForgetRepo,
      repos: string[],
      forgetRepositories: ForgetRepositories,
      removeHistory: boolean
    ) => {
      const forgotten = repo.forgetProject(
        projectId,
        () => forgetRepositories(repos),
        removeHistory
      );
      return 'reason' in forgotten
        ? { reason: { ok: false as const, reason: forgotten.reason } }
        : { value: forgotten };
    },
    ['projectId', 'repo', 'repos', 'forgetRepositories', 'removeHistory'],
    'result:outcome'
  )
  .pipe((repos: string[]) => ({ ok: true as const, repos }), 'repos', 'outcome')
  .end('outcome') as (
  projectId: string,
  caller: OperationCaller,
  repo: ForgetRepo,
  forgetRepositories: ForgetRepositories,
  removeHistory: boolean
) => Forgotten;

export function createNeoProjectForgetOperation(
  repo: Pick<NeoRepository, 'forgetProjectCommand'>,
  afterForget: (repos: readonly string[]) => void | Promise<void> = () => {}
) {
  const forget = (superpipe({})('neo.project.forget') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      async (input: z.infer<typeof Input>, caller: OperationCaller) => {
        const result = await repo.forgetProjectCommand(
          input.projectId,
          caller,
          input.removeHistory
        );
        return result.ok ? { value: result } : { reason: result };
      },
      ['input', 'caller'],
      'result:outcome'
    )
    .pipe(
      async (result: ForgetSuccess) => {
        await afterForget(result.repos);
        return result;
      },
      'outcome',
      'outcome'
    )
    .endAsync('outcome') as (
    input: z.infer<typeof Input>,
    caller: OperationCaller
  ) => Promise<Forgotten>;
  return defineOperation({
    name: 'neo.project.forget',
    description: neoToolDescription('neo.project.forget'),
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input, caller) => forget(input, caller),
  });
}
