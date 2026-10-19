import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';

const APPROVAL_ONLY = /^needs \d+ approving reviews?, has \d+$/;

export function isNeoCardPrRoutine(pr: NeoWorkPr): boolean {
  if (pr.state !== 'OPEN') return false;
  if (pr.checks === 'pending') return true;
  if (pr.checks === 'failing' || pr.review !== 'none') return false;
  return (pr.blockers ?? []).every((blocker) => APPROVAL_ONLY.test(blocker));
}
