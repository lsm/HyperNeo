import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { DevicePairingRepository } from './device-pairing-repository.ts';

class PairingStateReader {
  constructor(private readonly db: Database) {}

  isActiveDevice(id: string) {
    return new DevicePairingRepository(this.db).isActiveDevice(id);
  }
}

export const pairingStateReads = defineRepositoryOp(
  'pairing.state.read',
  'read',
  PairingStateReader,
  ['isActiveDevice'] as const
);
