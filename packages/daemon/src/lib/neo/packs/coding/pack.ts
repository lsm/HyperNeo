import { NEO_PACK_CODING_INSTRUCTIONS } from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoEvidence } from '../../evidence.ts';
import type { NeoPack, NeoPackBrief, NeoPackCheck } from '../types.ts';
import { extractNeoAskRefs, neoAskRefNews, type NeoRefStateReader } from './ask-prs.ts';
import type { NeoWorkPrRepository, NeoWorkPrRow } from './neo-work-pr-repository.ts';
import { extractNeoWorkPrUrls, neoWorkPrEvidence, type NeoWorkPrReader } from './work-prs.ts';

export const CODING_PACK_BRIEF: NeoPackBrief = {
  id: 'coding',
  describe: 'Software work in git repositories: pull requests, CI, review and merging.',
};

export const CODING_CHECK_PR_MERGED = 'coding.pr_merged';

export const codingPrMergedCheck: NeoPackCheck = (_item, evidence: readonly NeoEvidence[]) =>
  evidence.length && evidence.every((item) => item.state === 'done')
    ? { value: `Merged: ${evidence.map((item) => item.key).join(', ')}` }
    : { reason: 'not_merged' };

export function createCodingPack(deps: {
  readPrs: NeoWorkPrReader;
  readRefStates: NeoRefStateReader;
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
    checks: { [CODING_CHECK_PR_MERGED]: codingPrMergedCheck },
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
      const tracked = deps.workPrs.list(ask.workIds).flatMap((row) => row.prs.map((pr) => pr.url));
      const refs = extractNeoAskRefs(ask, tracked);
      return refs.length ? neoAskRefNews(await deps.readRefStates(refs), ask.createdAt) : [];
    },
  };
}
