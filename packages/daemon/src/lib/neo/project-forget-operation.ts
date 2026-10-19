import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation } from '../operations/registry.ts';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';

type ForgetRepo = Pick<NeoRepository, 'allRepositories' | 'forgetProject'>;
type Forgotten = { ok: true; repos: string[] } | { ok: false; reason: 'missing' | 'in_use' };

const Input = z.object({ projectId: z.string().min(1).max(100) });

const Result = z.union([
  z.object({ ok: z.literal(true), repos: z.array(z.string()) }),
  z.object({ ok: z.literal(false), reason: z.enum(['missing', 'in_use']) }),
]);

const runForget = (superpipe({})('neo.project.forget') as PipelineAPI)
  .input(['projectId', 'repo'])
  .pipe(
    (projectId: string, repo: ForgetRepo) => repo.allRepositories(projectId),
    ['projectId', 'repo'],
    'repos'
  )
  .pipe(
    (projectId: string, repo: ForgetRepo) => {
      const forgotten = repo.forgetProject(projectId);
      return 'reason' in forgotten
        ? { reason: { ok: false as const, reason: forgotten.reason } }
        : { value: forgotten };
    },
    ['projectId', 'repo'],
    'result:outcome'
  )
  .pipe((repos: string[]) => ({ ok: true as const, repos }), 'repos', 'outcome')
  .end('outcome') as (projectId: string, repo: ForgetRepo) => Forgotten;

export function createNeoProjectForgetOperation(repo: ForgetRepo) {
  return defineOperation({
    name: 'neo.project.forget',
    description:
      'Delete a project at the human’s request: its workspace aliases, holder binding and row go, so its repositories leave the PR ledger. The holder session itself is kept. The repository and local folders are untouched; new work in one of its folders creates a project again. Refuses a project that still has child sections, cards, asks or merges (in_use).',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: async (input) => runForget(input.projectId, repo),
  });
}
