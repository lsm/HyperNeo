import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../sqlite-compat.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { DevicePairingRepository, type DeviceKind } from './device-pairing-repository.ts';
import { isLocalUser } from '../../lib/operations/caller.ts';
import type { OperationCaller } from '../../lib/operations/registry.ts';
import { planPairingCode, refused } from '../../lib/pairing/pairing-operations.ts';

export type PairingCodeCaller = Pick<OperationCaller, 'source' | 'principal' | 'device'>;
export type PairingCodeDraft = {
  kind: DeviceKind;
  name: string | null;
  caller: PairingCodeCaller;
  now: number;
  twoWay?: boolean;
};
type Draft = PairingCodeDraft;

export const TWO_WAY_HUMAN_ONLY = 'two_way_human_only: only human codes can use two-way confirm.';
type Receipt =
  | { ok: false; reason: string }
  | { ok: true; codeId: string; code: string; expiresAt: number; approval: 'approved' | 'pending' };

const commitCodeCreation = (superpipe({})('pairing.code.create') as PipelineAPI)
  .input(['db', 'draft'])
  .pipe((db: Database) => new DevicePairingRepository(db), 'db', 'repo')
  .pipe(
    (repo: DevicePairingRepository, draft: Draft) => {
      const pairedHuman =
        isLocalUser(draft.caller) &&
        draft.caller.device?.kind === 'human' &&
        repo.isActiveDevice(draft.caller.device.deviceId);
      const plan = planPairingCode(
        draft.caller,
        repo.countDevices(),
        pairedHuman,
        draft.kind === 'human' && repo.humanRecoveryOpen(),
        draft.kind
      );
      if (!plan) return { reason: refused };
      if (draft.twoWay && draft.kind !== 'human')
        return { reason: { ok: false as const, reason: TWO_WAY_HUMAN_ONLY } };
      return 'reason' in plan
        ? { reason: { ok: false as const, reason: plan.reason } }
        : { value: plan };
    },
    ['repo', 'draft'],
    'result:receipt'
  )
  .pipe(
    (repo: DevicePairingRepository, draft: Draft, plan: { approved: boolean }): Receipt => {
      const approved = plan.approved && !draft.twoWay;
      const made = repo.createCode(draft.kind, draft.name, approved, draft.now, draft.twoWay);
      return {
        ok: true,
        codeId: made.id,
        code: made.code,
        expiresAt: made.expiresAt,
        approval: approved ? 'approved' : 'pending',
      };
    },
    ['repo', 'draft', 'receipt'],
    'receipt'
  )
  .end('receipt') as (db: Database, draft: Draft) => Receipt;

class PairingCodeCreator {
  constructor(private readonly db: Database) {}

  create(draft: Draft) {
    return commitCodeCreation(this.db, draft);
  }
}

export const pairingCodeCreateWrites = defineRepositoryOp(
  'pairing.createCode.write',
  'write',
  PairingCodeCreator,
  ['create'] as const
);
