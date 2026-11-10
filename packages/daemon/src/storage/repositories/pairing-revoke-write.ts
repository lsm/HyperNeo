import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../sqlite-compat.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import { DevicePairingRepository } from './device-pairing-repository.ts';
import type { OperationCaller } from '../../lib/operations/registry.ts';
import { isLocalUser } from '../../lib/operations/caller.ts';
import { fromDoor, NEEDS_PAIRED_HUMAN, refused } from '../../lib/pairing/pairing-operations.ts';

type Caller = Pick<OperationCaller, 'source' | 'principal' | 'device'>;
type Draft = { deviceId: string; caller: Caller; now: number };
type Receipt = { ok: true } | { ok: false; reason: string };

const commitRevocation = (superpipe({})('pairing.device.revoke') as PipelineAPI)
  .input(['db', 'draft'])
  .pipe((db: Database) => new DevicePairingRepository(db), 'db', 'repo')
  .pipe(
    (repo: DevicePairingRepository, draft: Draft) => {
      if (!isLocalUser(draft.caller) && !fromDoor(draft.caller)) return { reason: refused };
      if (
        !fromDoor(draft.caller) &&
        !(
          draft.caller.device?.kind === 'human' && repo.isActiveDevice(draft.caller.device.deviceId)
        )
      ) {
        return { reason: { ok: false as const, reason: NEEDS_PAIRED_HUMAN } };
      }
      return { value: draft };
    },
    ['repo', 'draft'],
    'result:receipt'
  )
  .pipe(
    (repo: DevicePairingRepository, draft: Draft): Receipt =>
      repo.revokeDevice(draft.deviceId, draft.now)
        ? { ok: true }
        : { ok: false, reason: 'not_found: no paired device with that id.' },
    ['repo', 'receipt'],
    'receipt'
  )
  .end('receipt') as (db: Database, draft: Draft) => Receipt;

class PairingRevoker {
  constructor(private readonly db: Database) {}

  revoke(deviceId: string, caller: Caller, now: number) {
    return commitRevocation(this.db, { deviceId, caller, now });
  }
}

export const pairingRevokeWrites = defineRepositoryOp(
  'pairing.revokeDevice.write',
  'write',
  PairingRevoker,
  ['revoke'] as const
);
