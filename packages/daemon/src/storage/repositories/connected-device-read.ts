import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { DevicePairingRepository } from './device-pairing-repository.ts';

class ConnectedDeviceReader {
  constructor(private readonly db: Database) {}

  inactive(ids: readonly string[]) {
    const repo = new DevicePairingRepository(this.db);
    return ids.filter((id) => !repo.isActiveDevice(id));
  }
}

export const connectedDeviceReads = defineRepositoryOp(
  'pairing.connectedDevices.read',
  'read',
  ConnectedDeviceReader,
  ['inactive'] as const
);
