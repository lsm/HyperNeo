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
    description:
      'Read GitHub as it is now. With {url}, one pull request or issue: a pull request returns its state (OPEN, MERGED or CLOSED), checks (passing, failing, pending or none), review verdict on its current head (approved, changes_requested or none), merge blockers and title; an issue returns its state, how it closed (completed, not_planned or duplicate), the merged pull request that closed it, and its parent issue. With {repo: "owner/name", kind: "pr" or "issue", state: "open", "merged", "closed" or "all", by: "created", "updated", "merged" or "closed", since, until (ISO times) or withinHours (the last N hours up to now), limit}, a list: every match in that window with number, title, url, state, createdAt, updatedAt, mergedAt and closedAt, newest first, truncated when more matched than limit, and window {by, since, until} saying what the read covered (until is the read time when you leave it out, so leave it out for "recently" or "last N hours"). by defaults to merged for state merged, closed for closed, otherwise created. Use the list for any question about what happened in a time range ("which PRs merged in the last 2 hours") instead of guessing numbers and reading them one by one. Read-only.',
    inputSchema: GithubRead,
    resultSchema: z.union([NeoGithubReadResult, NeoGithubQueryResult]),
    policy: { safetyClass: 'read', roles: ['neo'] },
    execute: async (input): Promise<NeoGithubReadResult | NeoGithubQueryResult> =>
      input.url
        ? await readNeoGithubRef(readers, input.url)
        : await queryNeoGithub(readers.listGithub, { ...input, repo: input.repo! }),
  });
}
