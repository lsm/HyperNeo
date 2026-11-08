import { pairFingerprint } from './pair-fingerprint.ts';

export interface PairApprovalFacts {
  active: boolean;
  terminal: boolean;
  terminalMayApprove: boolean;
  code: { twoWay: boolean; codeHash: string; requestedBy: string | null } | null;
  lastGroup?: string;
}

export type PairApprovalStep =
  | 'approve'
  | 'wrong_fingerprint'
  | 'not_pending'
  | 'not_paired'
  | 'not_requested';

export function decidePairApproval(facts: PairApprovalFacts): PairApprovalStep {
  const { code } = facts;
  if (!facts.active) return 'not_paired';
  if (!code) return 'not_pending';
  if (facts.terminal && !facts.terminalMayApprove) return 'not_paired';
  if (!code.twoWay) return 'approve';
  if (!code.requestedBy) return 'not_requested';
  const lastGroup = pairFingerprint(code.codeHash, code.requestedBy)[7];
  return facts.lastGroup?.toLowerCase() === lastGroup ? 'approve' : 'wrong_fingerprint';
}
