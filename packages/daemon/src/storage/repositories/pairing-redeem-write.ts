import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { DevicePairingRepository } from './device-pairing-repository.ts';

class PairingRedeemer {
  constructor(private readonly db: Database) {}

  redeem(code: string, name: string, now: number) {
    const repo = new DevicePairingRepository(this.db);
    const paired = repo.redeem(code, name, now);
    return { paired, awaitingApproval: paired === null && repo.isAwaitingApproval(code, now) };
  }
}

export const pairingRedeemWrite = defineRepositoryOp(
  'pairing.redeemCode.write',
  'write',
  PairingRedeemer,
  ['redeem'] as const
);
