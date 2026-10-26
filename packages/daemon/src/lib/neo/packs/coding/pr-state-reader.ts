import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { CodingMergeFactsRepository } from './merge-facts.ts';
import { NEO_WORK_PR_READ_MS } from './work-prs.ts';

type Subject = { repo: string; number: number };
type Facts = ReturnType<CodingMergeFactsRepository['read']>;
type State = 'OPEN' | 'CLOSED' | 'MERGED';
type Outcome = { value: State } | { reason: string };

function subject(url: string): { value: Subject } | { reason: Outcome } {
  const pr = parsePrUrl(url.toLowerCase());
  if (!pr) return { reason: { reason: 'Unable to parse GitHub PR URL' } };
  const allowed = (process.env.GH_HOST || 'github.com').toLowerCase();
  if (pr.host !== 'github.com' && pr.host !== allowed)
    return { reason: { reason: `PR host ${pr.host} is not allowed for GitHub lookups` } };
  return {
    value: {
      repo: `${pr.host === 'github.com' ? '' : `${pr.host}/`}${pr.owner}/${pr.repo}`,
      number: Number(pr.number),
    },
  };
}

async function readState(
  getDatabase: () => Database,
  target: Subject,
  spawn: SpawnFn,
  now: () => number
) {
  const facts = new CodingMergeFactsRepository(getDatabase());
  const current = await facts.readCurrent(target.repo, target.number, now(), NEO_WORK_PR_READ_MS);
  return current.merge.status === 'known' &&
    current.merge.value.state === 'MERGED' &&
    current.merge.value.mergeCommit
    ? Promise.resolve(current)
    : facts.refresh(target.repo, target.number, spawn, now, true);
}

function stateOutcome(facts: Facts): Outcome {
  return facts.merge.status === 'known'
    ? { value: facts.merge.value.state }
    : { reason: `GitHub PR state unavailable: ${facts.merge.reason}` };
}

export function createCodingPrStateReader(
  getDatabase: () => Database,
  spawn: SpawnFn = spawnProcess,
  now = Date.now
): (url: string) => Promise<Outcome> {
  return (superpipe({ getDatabase, spawn, now })('coding-ledger-pr-state-read') as PipelineAPI)
    .input('url')
    .pipe(subject, 'url', 'result:outcome')
    .pipe(readState, ['getDatabase', 'outcome', 'spawn', 'now'], 'facts')
    .pipe(stateOutcome, 'facts', 'outcome')
    .endAsync('outcome') as (url: string) => Promise<Outcome>;
}
