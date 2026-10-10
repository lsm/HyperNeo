import { NEO_PACK_CODING_INSTRUCTIONS } from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoPack, NeoPackBrief } from '../types.ts';
import { extractNeoAskPrUrls, neoAskPrNews, type NeoPrStateReader } from './ask-prs.ts';
import type { NeoWorkPrRepository, NeoWorkPrRow } from './neo-work-pr-repository.ts';
import { extractNeoWorkPrUrls, neoWorkPrEvidence, type NeoWorkPrReader } from './work-prs.ts';

export const CODING_PACK_BRIEF: NeoPackBrief = {
  id: 'coding',
  describe: 'Software work in git repositories: pull requests, CI, review and merging.',
};

export function createCodingPack(deps: {
  readPrs: NeoWorkPrReader;
  readPrStates: NeoPrStateReader;
  workPrs: Pick<NeoWorkPrRepository, 'get' | 'list' | 'recordFailedRead'>;
  record: (
    workId: string,
    prs: readonly NeoWorkPr[],
    before: NeoWorkPrRow | null
  ) => NeoWorkPrRow | null;
}): NeoPack {
  return {
    ...CODING_PACK_BRIEF,
    instructions: () => NEO_PACK_CODING_INSTRUCTIONS,
    readEvidence: async (work: NeoWork) => {
      const stored = deps.workPrs.get(work.id);
      const urls = extractNeoWorkPrUrls(work.report, stored?.prs);
      if (!urls.length) return null;
      const prs = await deps.readPrs(urls);
      if (!prs) deps.workPrs.recordFailedRead(work.id, Date.now());
      const row = prs ? deps.record(work.id, prs, stored) : stored;
      return row
        ? { evidence: neoWorkPrEvidence(row.prs), read: { ok: !!prs, okAt: row.readOkAt } }
        : null;
    },
    readAskEvidence: async (ask: NeoAsk) => {
      const tracked = new Set(
        deps.workPrs.list(ask.workIds).flatMap((row) => row.prs.map((pr) => pr.url))
      );
      const urls = extractNeoAskPrUrls(ask, tracked);
      return urls.length ? neoAskPrNews(await deps.readPrStates(urls), ask.createdAt) : [];
    },
  };
}
