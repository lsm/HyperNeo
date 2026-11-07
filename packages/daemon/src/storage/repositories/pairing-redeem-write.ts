import superpipe, { type PipelineAPI } from 'superpipe';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { DevicePairingRepository } from './device-pairing-repository.ts';
import {
  decidePairRequest,
  requesterOf,
  type PairRequest,
  type PairRequestRecord,
  type PairRequestStep,
} from '../../lib/pairing/pair-request.ts';

type Redeemed = ReturnType<DevicePairingRepository['redeem']>;
type Outcome = { paired: Redeemed; awaitingApproval: boolean };
type Facts = {
  repo: DevicePairingRepository;
  request: PairRequest;
  record: PairRequestRecord;
  now: number;
};

const refused: Outcome = { paired: null, awaitingApproval: false };
const awaiting: Outcome = { paired: null, awaitingApproval: true };

const applyStep: Record<PairRequestStep, (facts: Facts) => Outcome> = {
  refuse: () => refused,
  wait: () => awaiting,
  record: ({ repo, record, request }) => {
    repo.recordRequester(record.id, request.name, requesterOf(request));
    return awaiting;
  },
  void: ({ repo, record, now }) => {
    repo.voidCode(record.id, now);
    return refused;
  },
  redeem: ({ repo, request, now }) => ({
    paired: repo.redeem(request.code, request.name, now),
    awaitingApproval: false,
  }),
};

const redeemPairRequest = (superpipe({})('pairing.redeem-request') as PipelineAPI)
  .input(['repo', 'request', 'now'])
  .pipe(
    (repo: DevicePairingRepository, request: PairRequest, now: number) =>
      repo.pairRequest(request.code, now),
    ['repo', 'request', 'now'],
    'record'
  )
  .pipe(decidePairRequest, ['record', 'request'], 'step')
  .pipe(
    (step: PairRequestStep, repo, request, record, now) =>
      applyStep[step]({ repo, request, record, now }),
    ['step', 'repo', 'request', 'record', 'now'],
    'outcome'
  )
  .end('outcome') as (repo: DevicePairingRepository, request: PairRequest, now: number) => Outcome;

class PairingRedeemer {
  constructor(private readonly db: Database) {}

  redeem(request: PairRequest, now: number): Outcome {
    return redeemPairRequest(new DevicePairingRepository(this.db), request, now);
  }
}

export const pairingRedeemWrite = defineRepositoryOp(
  'pairing.redeemCode.write',
  'write',
  PairingRedeemer,
  ['redeem'] as const
);
