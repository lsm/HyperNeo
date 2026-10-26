import { homedir } from 'node:os';
import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { Logger } from '../../../logger.ts';
import { spawnProcess } from '../../../runtime-spawn/index.ts';

export type CodingLedgerRead = (repo: string) => Promise<unknown | null>;

const log = new Logger('NeoCodingLedger');

const DONE_FIELDS =
  'number title body headRefName headRefOid state isDraft mergeable reviewDecision closedAt createdAt';

const FIELDS = `${DONE_FIELDS}
  files(first: 100) { nodes { path } pageInfo { hasNextPage } }
  reviews(last: 30, states: [APPROVED, CHANGES_REQUESTED]) { nodes { state commit { oid } author { login } } }
  author { login __typename }
  comments(last: 10) { nodes { author { login } createdAt } }
  replies: reviews(last: 10, states: [COMMENTED]) { nodes { author { login } submittedAt } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } checkSuites(first: 1) { totalCount } } } }`;

export const CODING_LEDGER_QUERY = `query($o: String!, $n: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $o, name: $n) {
    nameWithOwner
    open: pullRequests(states: OPEN, first: 100) { pageInfo { hasNextPage } nodes { ${FIELDS} } }
    done: pullRequests(states: [MERGED, CLOSED], first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${DONE_FIELDS} } }
  }
}`;

export function codingLedgerArgs(repo: string): string[] {
  const [owner, name] = repo.split('/');
  return [
    'gh',
    'api',
    'graphql',
    '-f',
    `query=${CODING_LEDGER_QUERY}`,
    '-f',
    `o=${owner}`,
    '-f',
    `n=${name}`,
  ];
}

export const readCodingLedgerRepo: CodingLedgerRead = async (repo) => {
  const started = Date.now();
  const outcome = await runGhJson(codingLedgerArgs(repo), homedir(), spawnProcess, {
    resourceHint: 'graphql',
  });
  const budget = z
    .object({
      data: z.object({
        rateLimit: z.object({
          cost: z.number(),
          remaining: z.number(),
          resetAt: z.string(),
        }),
      }),
    })
    .safeParse(outcome.ok ? outcome.data : null);
  log.info('PR ledger GitHub read', {
    repo,
    resource: 'graphql',
    elapsedMs: Date.now() - started,
    ok: outcome.ok,
    cost: budget.success ? budget.data.data.rateLimit.cost : null,
    remaining: budget.success ? budget.data.data.rateLimit.remaining : null,
    resetAt: budget.success ? budget.data.data.rateLimit.resetAt : null,
    retryAfterMs: outcome.ok ? null : (outcome.retryAfterMs ?? null),
  });
  return outcome.ok
    ? outcome.data
    : { error: outcome.error, retryAt: Date.now() + (outcome.retryAfterMs ?? 0) };
};
