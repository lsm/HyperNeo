import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoEvidence } from '../../evidence.ts';
import type { NeoPack, NeoPackCheck } from '../types.ts';
import type { NeoWorkPrRepository, NeoWorkPrRow } from './neo-work-pr-repository.ts';
import { extractNeoWorkPrUrls, neoWorkPrEvidence, type NeoWorkPrReader } from './work-prs.ts';

export const codingPrMergedCheck: NeoPackCheck = (_item, evidence: readonly NeoEvidence[]) =>
  evidence.length && evidence.every((item) => item.state === 'done')
    ? { value: `Merged: ${evidence.map((item) => item.key).join(', ')}` }
    : { reason: 'not_merged' };

export function createCodingPack(deps: {
  readPrs: NeoWorkPrReader;
  workPrs: Pick<NeoWorkPrRepository, 'get' | 'recordFailedRead'>;
  record: (
    workId: string,
    prs: readonly NeoWorkPr[],
    before: NeoWorkPrRow | null
  ) => NeoWorkPrRow | null;
}): NeoPack {
  return {
    id: 'coding',
    describe: 'Software work in git repositories: pull requests, CI, review and merging.',
    instructions: () => null,
    checks: { pr_merged: codingPrMergedCheck },
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
  };
}
