import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  type NeoCardGroup,
  type NeoCardPhase,
  type NeoWorkDriverReceipt,
  type NeoWorkPr,
  neoWorkPrVerdict,
} from '@hyperneo/shared/types/neo-snapshot';

const stuck = (pr: NeoWorkPr) => pr.state === 'OPEN' && neoWorkPrVerdict(pr) === 'failed';

export function neoHeadlinePr(prs: readonly NeoWorkPr[]): NeoWorkPr | undefined {
  return prs.find(stuck) ?? prs.find((pr) => pr.state === 'OPEN') ?? prs[0];
}

export function neoCardPrInProgress(prs: readonly NeoWorkPr[]): boolean {
  return prs.some((pr) => pr.state === 'OPEN') && !prs.some(stuck);
}

function reportedPhase(prs: readonly NeoWorkPr[]): NeoCardPhase {
  const pr = neoHeadlinePr(prs);
  if (!pr) return 'reported';
  if (neoCardPrInProgress(prs)) return 'pr_open';
  return neoWorkPrVerdict(pr) === 'done' ? 'merged' : 'pr_setback';
}

function queuedPhase(driver: NeoWorkDriverReceipt | undefined): NeoCardPhase {
  if (!driver) return 'handed';
  if (driver.status === 'failed' || driver.status === 'stopped') return 'stopped';
  if (driver.abandoned) return 'abandoned';
  if (driver.status === 'needs_you') return 'needs_you';
  if (driver.status === 'running') return 'running';
  if (driver.status === 'done') return 'checking';
  return 'handed';
}

export function neoCardPhase(
  work: Pick<NeoWork, 'status'>,
  driver: NeoWorkDriverReceipt | undefined,
  prs: readonly NeoWorkPr[]
): NeoCardPhase {
  if (work.status === 'queued') return queuedPhase(driver);
  if (work.status === 'reported') return reportedPhase(prs);
  return work.status;
}

const groups: Record<NeoCardPhase, NeoCardGroup> = {
  proposed: 'attention',
  needs_you: 'attention',
  abandoned: 'attention',
  handed: 'running',
  running: 'running',
  checking: 'running',
  pr_open: 'running',
  stopped: 'outcomes',
  pr_setback: 'outcomes',
  merged: 'outcomes',
  reported: 'outcomes',
  failed: 'outcomes',
  cancelled: 'outcomes',
};

export function neoCardGroup(phase: NeoCardPhase): NeoCardGroup {
  return groups[phase];
}
