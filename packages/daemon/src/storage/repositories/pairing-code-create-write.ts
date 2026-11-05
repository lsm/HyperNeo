import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../sqlite-compat.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { DevicePairingRepository, type DeviceKind } from './device-pairing-repository.ts';
import { isLocalUser } from '../../lib/operations/caller.ts';
import type { OperationCaller } from '../../lib/operations/registry.ts';
import { planPairingCode, refused } from '../../lib/pairing/pairing-operations.ts';

export type PairingCodeCaller = Pick<OperationCaller, 'source' | 'principal' | 'device'>;
type Draft = { kind: DeviceKind; name: string | null; caller: PairingCodeCaller; now: number };
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
        draft.kind === 'human' && repo.humanRecoveryOpen()
      );
      if (!plan) return { reason: refused };
      return 'reason' in plan
        ? { reason: { ok: false as const, reason: plan.reason } }
        : { value: plan };
    },
    ['repo', 'draft'],
    'result:receipt'
  )
  .pipe(
    (repo: DevicePairingRepository, draft: Draft, plan: { approved: boolean }): Receipt => {
      const made = repo.createCode(draft.kind, draft.name, plan.approved, draft.now);
      return {
        ok: true,
        codeId: made.id,
        code: made.code,
        expiresAt: made.expiresAt,
        approval: plan.approved ? 'approved' : 'pending',
      };
    },
    ['repo', 'draft', 'receipt'],
    'receipt'
  )
  .end('receipt') as (db: Database, draft: Draft) => Receipt;

class PairingCodeCreator {
  constructor(private readonly db: Database) {}

  create(kind: DeviceKind, name: string | null, caller: PairingCodeCaller, now: number) {
    return commitCodeCreation(this.db, { kind, name, caller, now });
  }
}

export const pairingCodeCreateWrites = defineRepositoryOp(
  'pairing.createCode.write',
  'write',
  PairingCodeCreator,
  ['create'] as const
);
