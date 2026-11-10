import superpipe, { type PipelineAPI } from 'superpipe';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { resetHumanDevices } from './human-device-reset-repository.ts';

type Receipt = ReturnType<typeof resetHumanDevices>;
type Row = Omit<Receipt, 'devices'> & { devicesJson: string };

const readReceipt = (superpipe({})('human-device-reset-receipt') as PipelineAPI)
  .input(['db', 'id'])
  .pipe(
    (db: Database, id: string) =>
      db
        .prepare(`SELECT r.id, r.reset_at AS resetAt, r.devices_json AS devicesJson,
        p.conversation_id AS conversationId FROM human_device_resets r
        JOIN neo_publications p
          ON json_extract(p.payload_json, '$.producerInput.sessionId') = 'daemon:device-recovery'
          AND json_extract(p.payload_json, '$.producerInput.messageId') = r.id
        WHERE r.id = ? ORDER BY p.sequence LIMIT 1`)
        .get(id) as Row | null,
    ['db', 'id'],
    'row'
  )
  .pipe((row: Row | null) => (row ? { value: row } : { reason: null }), 'row', 'result:receipt')
  .pipe(
    (row: Row): Receipt => ({
      id: row.id,
      resetAt: row.resetAt,
      conversationId: row.conversationId,
      devices: JSON.parse(row.devicesJson) as Receipt['devices'],
    }),
    'receipt',
    'receipt'
  )
  .end('receipt') as (db: Database, id: string) => Receipt | null;

class HumanDeviceResetReader {
  constructor(private readonly db: Database) {}

  receipt(id: string) {
    return readReceipt(this.db, id);
  }
}

export const humanDeviceResetReads = defineRepositoryOp(
  'pairing.humanReset.read',
  'read',
  HumanDeviceResetReader,
  ['receipt'] as const
);
