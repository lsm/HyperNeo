import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { resetHumanDevices } from './human-device-reset-repository.ts';

class HumanDeviceResetWriter {
  constructor(private readonly db: Database) {}

  reset(now: number) {
    return resetHumanDevices(this.db, now);
  }
}

export const humanDeviceResetWrites = defineRepositoryOp(
  'pairing.humanReset.write',
  'write',
  HumanDeviceResetWriter,
  ['reset'] as const
);
