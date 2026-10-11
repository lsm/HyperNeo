import { NEO_PACK_CODING_INSTRUCTIONS } from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoEvidence } from '../../evidence.ts';
import type { NeoPack, NeoPackBrief, NeoPackCheck } from '../types.ts';
import {
  extractNeoAskRefs,
  neoAskCardRefs,
  neoAskRefNews,
  type NeoRefStateReader,
} from './ask-prs.ts';
import { readNeoIssueTicks } from './issue-checks.ts';
import type { NeoWorkPrRepository, NeoWorkPrRow } from './neo-work-pr-repository.ts';
import type { NeoWorkPrClaimRepository } from './neo-work-pr-claim-repository.ts';
import {
  keepNeoCardPrReads,
  keepNeoUnbeatenPrs,
  planNeoCardPrOwnership,
  planNeoPrCedes,
  scoreNeoCardPrs,
  type NeoCardPrCandidate,
  type NeoCardPrOwned,
  type NeoPrClaimRow,
} from './card-pr-claims.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { githubUrlKey } from '../../../github/parse-pr-url.ts';
import {
  extractNeoWorkPrUrls,
  mergeNeoWorkPrReads,
  neoAskPrEvidence,
  neoWorkPrEvidence,
  shouldReadNeoWorkPrs,
  type NeoWorkPrReader,
} from './work-prs.ts';

export const CODING_PACK_BRIEF: NeoPackBrief = {
  id: 'coding',
  describe: 'Software work in git repositories: pull requests, CI, review and merging.',
};

export const CODING_CHECK_PR_MERGED = 'coding.pr_merged';

export const codingPrMergedCheck: NeoPackCheck = (_item, evidence: readonly NeoEvidence[]) => {
  const prs = evidence.filter((item) => /^https?:\/\//.test(item.key));
  return prs.length && evidence.every((item) => item.state === 'done')
    ? { value: `Merged: ${prs.map((item) => item.key).join(', ')}` }
    : { reason: 'not_merged' };
};

export interface NeoCardPrDeps {
  readPrs: NeoWorkPrReader;
  prCandidates: (work: NeoWork, stored: NeoWorkPrRow | null) => Promise<NeoCardPrCandidate[]>;
  claims: Pick<NeoWorkPrClaimRepository, 'forUrls' | 'replace' | 'drop'>;
  workPrs: Pick<NeoWorkPrRepository, 'get' | 'list' | 'recordFailedRead'>;
  record: (
    workId: string,
    prs: readonly NeoWorkPr[],
    before: NeoWorkPrRow | null,
    read?: boolean
  ) => NeoWorkPrRow | null;
}

type NeoCardPrRead = { row: NeoWorkPrRow | null; ok: boolean };
type NeoCardPrPlan = { owned: NeoCardPrOwned[] };

const ownedUrls = (plan: NeoCardPrPlan) => plan.owned.map((item) => item.url);
const stripReadTimes = (prs: readonly NeoWorkPr[]) =>
  prs.map(({ createdAt: _createdAt, title: _title, branch: _branch, ...pr }) => pr);

export function cachedNeoCardPrRead(row: NeoWorkPrRow | null): NeoCardPrRead {
  return { row, ok: !row || row.readOkAt >= row.readAt };
}

export function neoCardPrsFresh(
  current: { row: NeoWorkPrRow | null },
  plan: NeoCardPrPlan,
  now: number,
  force = false
): boolean {
  return (
    !force &&
    !shouldReadNeoWorkPrs(current.row, ownedUrls(plan), now) &&
    plan.owned.every((item) => item.claimed)
  );
}

export const readNeoCardPrs = (superpipe({})('neo-card-pr-read') as PipelineAPI)
  .input(['deps', 'work', 'stored', 'now', 'force'])
  .pipe(
    async (deps: NeoCardPrDeps, work: NeoWork, stored: NeoWorkPrRow | null) => ({
      candidates: await deps.prCandidates(work, stored),
    }),
    ['deps', 'work', 'stored'],
    'found'
  )
  .pipe(
    (
      deps: NeoCardPrDeps,
      work: NeoWork,
      found: { candidates: NeoCardPrCandidate[] },
      now: number
    ) => ({
      owned: planNeoCardPrOwnership(
        work,
        found.candidates,
        deps.claims.forUrls(found.candidates.map((item) => item.url)),
        now
      ),
    }),
    ['deps', 'work', 'found', 'now'],
    'plan'
  )
  .pipe(
    (deps: NeoCardPrDeps, work: NeoWork, stored: NeoWorkPrRow | null, plan: NeoCardPrPlan) => {
      const keep = new Set(ownedUrls(plan).map(githubUrlKey));
      const kept = stored?.prs.filter((pr) => keep.has(githubUrlKey(pr.url))) ?? [];
      if (!stored || kept.length === stored.prs.length) return { row: stored };
      deps.claims.replace(
        work.id,
        plan.owned.filter((item) => item.claimed)
      );
      return { row: deps.record(work.id, kept, stored, false) ?? stored };
    },
    ['deps', 'work', 'stored', 'plan'],
    'current'
  )
  .pipe(
    (current: { row: NeoWorkPrRow | null }) => ({ value: cachedNeoCardPrRead(current.row) }),
    ['current'],
    'result:read'
  )
  .pipe(neoCardPrsFresh, ['current', 'plan', 'now', 'force'], 'fresh')
  .pipe('!fresh')
  .pipe(
    async (deps: NeoCardPrDeps, plan: NeoCardPrPlan) => ({
      prs: await deps.readPrs(ownedUrls(plan)),
    }),
    ['deps', 'plan'],
    'fetched'
  )
  .pipe(
    (deps: NeoCardPrDeps, work: NeoWork, fetched: { prs: NeoWorkPr[] | null }, now: number) => {
      if (!fetched.prs) deps.workPrs.recordFailedRead(work.id, now);
    },
    ['deps', 'work', 'fetched', 'now']
  )
  .pipe(
    (
      deps: NeoCardPrDeps,
      work: NeoWork,
      plan: NeoCardPrPlan,
      fetched: { prs: NeoWorkPr[] | null }
    ) =>
      keepNeoUnbeatenPrs(
        work,
        scoreNeoCardPrs(work, plan.owned, fetched.prs ?? []),
        deps.claims.forUrls(ownedUrls(plan))
      ),
    ['deps', 'work', 'plan', 'fetched'],
    'unbeaten'
  )
  .pipe(
    (
      deps: NeoCardPrDeps,
      work: NeoWork,
      current: { row: NeoWorkPrRow | null },
      unbeaten: NeoCardPrPlan & { beaten: NeoCardPrOwned[] },
      fetched: { prs: NeoWorkPr[] | null }
    ) => {
      if (!fetched.prs) return { value: { row: current.row, ok: false } };
      const { kept, pending, rejected } = keepNeoCardPrReads(work, unbeaten.owned, fetched.prs);
      const outmatched = unbeaten.beaten.filter((item) => item.claim === 'mentioned');
      deps.claims.replace(work.id, [
        ...kept,
        ...[...rejected, ...outmatched].map((item) => ({ ...item, claim: 'rejected' as const })),
      ]);
      const prs = mergeNeoWorkPrReads(
        [...kept, ...pending].map((item) => item.url),
        fetched.prs,
        current.row?.prs
      );
      return {
        value: {
          row: deps.record(work.id, stripReadTimes(prs), current.row),
          ok: true,
        },
      };
    },
    ['deps', 'work', 'current', 'unbeaten', 'fetched'],
    'result:read'
  )
  .pipe(
    (deps: NeoCardPrDeps, work: NeoWork, read: NeoCardPrRead) => ({
      rows: planNeoPrCedes(work, deps.claims.forUrls(read.row?.prs.map((pr) => pr.url) ?? [])),
    }),
    ['deps', 'work', 'read'],
    'ceded'
  )
  .pipe(
    (deps: NeoCardPrDeps, ceded: { rows: NeoPrClaimRow[] }) => {
      for (const lost of ceded.rows) {
        const row = deps.workPrs.get(lost.workId);
        const prs = row?.prs.filter((pr) => githubUrlKey(pr.url) !== lost.urlKey);
        if (row && prs && prs.length !== row.prs.length) deps.record(lost.workId, prs, row, false);
        deps.claims.drop(lost.workId, lost.urlKey, lost.claim);
      }
    },
    ['deps', 'ceded']
  )
  .endAsync('read') as (
  deps: NeoCardPrDeps,
  work: NeoWork,
  stored: NeoWorkPrRow | null,
  now: number,
  force?: boolean
) => Promise<NeoCardPrRead>;

export function createCodingPack(
  deps: NeoCardPrDeps & {
    runningPrUrls: (workIds: readonly string[]) => Promise<string[]>;
    readRefStates: NeoRefStateReader;
  }
): NeoPack {
  return {
    ...CODING_PACK_BRIEF,
    instructions: () => NEO_PACK_CODING_INSTRUCTIONS,
    checks: { [CODING_CHECK_PR_MERGED]: codingPrMergedCheck },
    readEvidence: async (work: NeoWork) => {
      const { row, ok } = await readNeoCardPrs(deps, work, deps.workPrs.get(work.id), Date.now());
      return row?.prs.length
        ? { evidence: neoWorkPrEvidence(row.prs), read: { ok, okAt: row.readOkAt } }
        : null;
    },
    askCardEvidence: (ask: NeoAsk, works: readonly NeoWork[]) =>
      neoAskPrEvidence(
        works,
        deps.workPrs.list(ask.workIds),
        deps.claims.forUrls(works.flatMap((work) => extractNeoWorkPrUrls(work.report)))
      ),
    readAskTicks: (ask: NeoAsk, works: readonly NeoWork[]) =>
      readNeoIssueTicks(ask, works, deps.readRefStates, Date.now()),
    readAskEvidence: async (ask: NeoAsk) => {
      const tracked = deps.workPrs.list(ask.workIds).flatMap((row) => row.prs.map((pr) => pr.url));
      const refs = neoAskCardRefs(
        extractNeoAskRefs(ask, tracked),
        await deps.runningPrUrls(ask.workIds),
        tracked
      );
      return refs.length ? neoAskRefNews(await deps.readRefStates(refs), ask.createdAt) : [];
    },
  };
}
