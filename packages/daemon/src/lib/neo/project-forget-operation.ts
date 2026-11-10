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

const Input = z.object({ projectId: z.string().min(1).max(100) });

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

export const runNeoProjectForget = (superpipe({})('neo.project.forget') as PipelineAPI)
  .input(['projectId', 'caller', 'repo', 'forgetRepositories'])
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
      forgetRepositories: ForgetRepositories
    ) => {
      const forgotten = repo.forgetProject(projectId, () => forgetRepositories(repos));
      return 'reason' in forgotten
        ? { reason: { ok: false as const, reason: forgotten.reason } }
        : { value: forgotten };
    },
    ['projectId', 'repo', 'repos', 'forgetRepositories'],
    'result:outcome'
  )
  .pipe((repos: string[]) => ({ ok: true as const, repos }), 'repos', 'outcome')
  .end('outcome') as (
  projectId: string,
  caller: OperationCaller,
  repo: ForgetRepo,
  forgetRepositories: ForgetRepositories
) => Forgotten;

export function createNeoProjectForgetOperation(
  repo: Pick<NeoRepository, 'forgetProjectCommand'>,
  afterForget: (repos: readonly string[]) => void | Promise<void> = () => {}
) {
  return defineOperation({
    name: 'neo.project.forget',
    description: neoToolDescription('neo.project.forget'),
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: async (input, caller) => {
      const result = await repo.forgetProjectCommand(input.projectId, caller);
      if (result.ok) await afterForget(result.repos);
      return result;
    },
  });
}
