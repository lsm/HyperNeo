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
  prUrls: (work: NeoWork, stored: NeoWorkPrRow | null) => Promise<string[]>;
  workPrs: Pick<NeoWorkPrRepository, 'get' | 'list' | 'recordFailedRead'>;
  record: (
    workId: string,
    prs: readonly NeoWorkPr[],
    before: NeoWorkPrRow | null
  ) => NeoWorkPrRow | null;
}

type NeoCardPrRead = { row: NeoWorkPrRow | null; ok: boolean };

export const readNeoCardPrs = (superpipe({})('neo-card-pr-read') as PipelineAPI)
  .input(['deps', 'work', 'stored', 'now'])
  .pipe(
    async (deps: NeoCardPrDeps, work: NeoWork, stored: NeoWorkPrRow | null) => ({
      urls: await deps.prUrls(work, stored),
    }),
    ['deps', 'work', 'stored'],
    'found'
  )
  .pipe(
    (stored: NeoWorkPrRow | null, found: { urls: string[] }, now: number) =>
      shouldReadNeoWorkPrs(stored, found.urls, now)
        ? { value: found }
        : { reason: { row: stored, ok: !stored || stored.readOkAt >= stored.readAt } },
    ['stored', 'found', 'now'],
    'result:read'
  )
  .pipe(
    async (deps: NeoCardPrDeps, found: { urls: string[] }) => ({
      prs: await deps.readPrs(found.urls),
    }),
    ['deps', 'found'],
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
      stored: NeoWorkPrRow | null,
      found: { urls: string[] },
      fetched: { prs: NeoWorkPr[] | null }
    ) => ({
      value: {
        row: fetched.prs
          ? deps.record(work.id, mergeNeoWorkPrReads(found.urls, fetched.prs, stored?.prs), stored)
          : stored,
        ok: !!fetched.prs,
      },
    }),
    ['deps', 'work', 'stored', 'found', 'fetched'],
    'result:read'
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
