import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkDeliveryInputRepository } from '../../../../src/storage/repositories/work-delivery-input-repository.ts';
import { runMigration431 } from '../../../../src/storage/schema/m431-work-delivery-inputs.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

test('delivery intents retain original targets and deadlines after reopen and idempotent migration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-inputs-'));
  const path = join(root, 'synthetic.db');
  const target = {
    verb: 'send' as const,
    ref: { adapter: 'codex-desktop', id: 'worker', daemon: 'remote' },
  };
  let id = '';
  try {
    const db = new Database(path);
    try {
      runMigration431(db);
      const inputs = new WorkDeliveryInputRepository(db);
      id = await inputs.accept('todo', 'neo', target, 'Original instruction', 1000);
      await inputs.recordOutcome(
        id,
        {
          ref: target.ref,
          queued: true,
          delivery: { delivered: false, queuedSubmissionId: 'queue-1' },
        },
        2000
      );
      await expect(
        inputs.recordOutcome(id, { failure: 'late stale result' }, 3000)
      ).rejects.toThrow('already acknowledged');
      await inputs.accept('todo', 'neo', target, 'Different instruction', 2000);
      runMigration431(db);
    } finally {
      db.close();
    }
    const reopened = new Database(path, { readonly: true });
    try {
      const inputs = new WorkDeliveryInputRepository(reopened);
      expect(inputs.list('todo')).toMatchObject([
        {
          id,
          target,
          message: 'Original instruction',
          acceptedAt: 1000,
          deadlineAt: 31000,
          observedAt: 2000,
          outcome: { ref: target.ref, delivery: { queuedSubmissionId: 'queue-1' } },
        },
        {
          target,
          message: 'Different instruction',
          acceptedAt: 2000,
          deadlineAt: 32000,
          outcome: null,
        },
      ]);
      expect(inputs.due(30999)).toEqual([]);
      expect(inputs.due(40000, 1).map((input) => input.id)).toEqual([id]);
      expect(inputs.list('other')).toEqual([]);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
