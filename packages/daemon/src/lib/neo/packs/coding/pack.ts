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
import type { NeoWorkPrRepository, NeoWorkPrRow } from './neo-work-pr-repository.ts';
import type { NeoWorkPrClaimRepository } from './neo-work-pr-claim-repository.ts';
import {
  keepNeoCardPrReads,
  keepNeoUnbeatenPrs,
  planNeoCardPrOwnership,
  planNeoPrCedes,
  type NeoCardPrCandidate,
  type NeoCardPrOwned,
  type NeoPrClaimRow,
} from './card-pr-claims.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  mergeNeoWorkPrReads,
  neoWorkPrEvidence,
  shouldReadNeoWorkPrs,
  type NeoWorkPrReader,
} from './work-prs.ts';

export const CODING_PACK_BRIEF: NeoPackBrief = {
  id: 'coding',
  describe: 'Software work in git repositories: pull requests, CI, review and merging.',
};

export const CODING_CHECK_PR_MERGED = 'coding.pr_merged';

export const codingPrMergedCheck: NeoPackCheck = (_item, evidence: readonly NeoEvidence[]) =>
  evidence.length && evidence.every((item) => item.state === 'done')
    ? { value: `Merged: ${evidence.map((item) => item.key).join(', ')}` }
    : { reason: 'not_merged' };

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
  prs.map(({ createdAt: _createdAt, ...pr }) => pr);

export const readNeoCardPrs = (superpipe({})('neo-card-pr-read') as PipelineAPI)
  .input(['deps', 'work', 'stored', 'now'])
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
      const keep = new Set(ownedUrls(plan).map((url) => url.toLowerCase()));
      const kept = stored?.prs.filter((pr) => keep.has(pr.url.toLowerCase())) ?? [];
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
    (current: { row: NeoWorkPrRow | null }, plan: NeoCardPrPlan, now: number) =>
      shouldReadNeoWorkPrs(current.row, ownedUrls(plan), now) ||
      plan.owned.some((item) => !item.claimed)
        ? { value: plan }
        : {
            reason: {
              row: current.row,
              ok: !current.row || current.row.readOkAt >= current.row.readAt,
            },
          },
    ['current', 'plan', 'now'],
    'result:read'
  )
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
    (deps: NeoCardPrDeps, work: NeoWork, plan: NeoCardPrPlan) => ({
      owned: keepNeoUnbeatenPrs(work, plan.owned, deps.claims.forUrls(ownedUrls(plan))),
    }),
    ['deps', 'work', 'read'],
    'unbeaten'
  )
  .pipe(
    (
      deps: NeoCardPrDeps,
      work: NeoWork,
      current: { row: NeoWorkPrRow | null },
      plan: NeoCardPrPlan,
      fetched: { prs: NeoWorkPr[] | null }
    ) => {
      if (!fetched.prs) return { value: { row: current.row, ok: false } };
      const { kept, pending, rejected } = keepNeoCardPrReads(work, plan.owned, fetched.prs);
      deps.claims.replace(work.id, [
        ...kept,
        ...rejected.map((item) => ({ ...item, claim: 'rejected' as const })),
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
        deps.claims.drop(lost.workId, lost.urlKey);
        const row = deps.workPrs.get(lost.workId);
        const prs = row?.prs.filter((pr) => pr.url.toLowerCase() !== lost.urlKey);
        if (row && prs && prs.length !== row.prs.length) deps.record(lost.workId, prs, row, false);
      }
    },
    ['deps', 'ceded']
  )
  .endAsync('read') as (
  deps: NeoCardPrDeps,
  work: NeoWork,
  stored: NeoWorkPrRow | null,
  now: number
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
