import { recordWouldRefuse } from '../repositories/device-pairing-repository.ts';
import type { DbOp } from './db-op.ts';

export const DB_OPS: ReadonlyMap<string, DbOp<never, unknown>> = new Map(
  [recordWouldRefuse].map((op) => [op.name, op])
);
