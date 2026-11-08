import superpipe, { type PipelineAPI } from 'superpipe';
import { defineDbOp, defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { DevicePairingRepository } from './device-pairing-repository.ts';
import {
  decidePairApproval,
  type PairApprovalFacts,
  type PairApprovalStep,
} from '../../lib/pairing/pair-approval.ts';

type PairingApproval = Exclude<PairApprovalStep, 'approve'> | 'approved';
type PairingDenial = 'denied' | 'not_pending' | 'not_paired';

export interface PairApprovalRequest {
  codeId: string;
  deviceId: string;
  door: boolean;
  confirmCode?: string;
  now: number;
}

const approvalFacts = (
  repo: DevicePairingRepository,
  request: PairApprovalRequest
): PairApprovalFacts => ({
  active: repo.isActiveDevice(request.deviceId),
  terminal: request.door || request.deviceId.startsWith('local-rpc:'),
  terminalMayApprove: repo.terminalMayApprove(),
  code: repo.pendingCode(request.codeId, request.now),
  confirmCode: request.confirmCode,
});

const applyApproval = (
  step: PairApprovalStep,
  repo: DevicePairingRepository,
  { codeId, now }: PairApprovalRequest
): PairingApproval => {
  if (step === 'wrong_fingerprint') repo.deny(codeId, now);
  if (step !== 'approve') return step;
  return repo.approve(codeId, now) ? 'approved' : 'not_pending';
};

const approvePairCode = (superpipe({})('pairing.approve-code') as PipelineAPI)
  .input(['db', 'request'])
  .pipe((db: Database) => new DevicePairingRepository(db), 'db', 'repo')
  .pipe(approvalFacts, ['repo', 'request'], 'facts')
  .pipe(decidePairApproval, ['facts'], 'step')
  .pipe(applyApproval, ['step', 'repo', 'request'], 'outcome')
  .end('outcome') as (db: Database, request: PairApprovalRequest) => PairingApproval;

export const pairingApproveWrite = defineDbOp<PairApprovalRequest, PairingApproval>({
  name: 'pairing.approveCode.write',
  mode: 'write',
  run: (db, request) => approvePairCode(db, request),
});

class TerminalApprovalWriter {
  constructor(private readonly db: Database) {}

  set(enabled: boolean, changedBy: string, now: number): boolean {
    const repo = new DevicePairingRepository(this.db);
    if (enabled && !repo.isActiveDevice(changedBy)) return false;
    return repo.setTerminalApproval(enabled, changedBy, now) === enabled;
  }
}

export const pairingTerminalApprovalWrites = defineRepositoryOp(
  'pairing.terminalApproval.write',
  'write',
  TerminalApprovalWriter,
  ['set'] as const
);

export const pairingDenyWrite = defineDbOp<
  { codeId: string; deviceId: string; now: number },
  PairingDenial
>({
  name: 'pairing.denyCode.write',
  mode: 'write',
  run: (db, { codeId, deviceId, now }) => {
    const repo = new DevicePairingRepository(db);
    if (!repo.isActiveDevice(deviceId)) return 'not_paired';
    return repo.deny(codeId, now) ? 'denied' : 'not_pending';
  },
});
