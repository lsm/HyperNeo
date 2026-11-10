import { neoToolDescription } from '@hyperneo/prompts';
import { z } from 'zod';
import { defineOperation } from '../../../operations/registry.ts';
import { NeoGithubReadResult, readNeoGithubRef, type NeoGithubReaders } from './github-read.ts';
import {
  NeoGithubQuery,
  NeoGithubQueryResult,
  queryNeoGithub,
  type NeoGithubLister,
} from './github-query.ts';

const GithubRead = NeoGithubQuery.partial({ repo: true })
  .extend({ url: z.string().trim().min(1).max(500).optional() })
  .refine((input) => !input.url !== !input.repo, 'Pass either url or repo.');
export function createCodingGithubReadOperation(
  readers: NeoGithubReaders & { listGithub: NeoGithubLister }
) {
  return defineOperation({
    name: 'neo.github.read',
    description: neoToolDescription('neo.github.read'),
    inputSchema: GithubRead,
    resultSchema: z.union([NeoGithubReadResult, NeoGithubQueryResult]),
    policy: { safetyClass: 'read', roles: ['neo'] },
    execute: async (input): Promise<NeoGithubReadResult | NeoGithubQueryResult> =>
      input.url
        ? await readNeoGithubRef(readers, input.url)
        : await queryNeoGithub(readers.listGithub, { ...input, repo: input.repo! }),
  });
}
