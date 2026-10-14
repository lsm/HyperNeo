import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/database.ts';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoWorkDriverTargetRepository } from '../../../../src/storage/repositories/neo-work-driver-target-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

const target = {
  verb: 'start' as const,
  adapter: 'codex-desktop',
  place: { machine: 'laptop', name: 'repo' },
  model: 'requested-alias',
  effort: 'requested-effort',
};
const ref = { adapter: 'codex-desktop', id: 'thread-1' };
const proposal = {
  id: 'work-1',
  requestKey: 'configuration',
  projectId: null,
  originSessionId: 'neo:root',
  title: 'Update the app',
  instruction: 'Use the requested configuration',
};

function propose(db: Database) {
  const raw = db.getDatabase();
  const targets = new NeoWorkDriverTargetRepository(raw);
  targets.propose(new NeoRepository(raw), proposal, target);
  return targets;
}

describe('NeoWorkDriverTargetRepository configuration receipts', () => {
  test('never infers observed settings from the requested target and clears stale replacements', async () => {
    const db = await createTestDb();
    try {
      const targets = propose(db);
      const receipt = () => targets.receipts([proposal.id], 100)[0];
      expect(receipt()).not.toHaveProperty('model');
      expect(receipt()).not.toHaveProperty('effort');
      targets.recordRef(proposal.id, ref, 100, 'codex://threads/thread-1', {
        model: 'gpt-6.1-sol',
        effort: 'medium',
      });
      targets.recordLive(proposal.id, 'running', undefined);
      expect(receipt()).toMatchObject({
        model: 'gpt-6.1-sol',
        effort: 'medium',
        status: 'running',
      });
      expect(targets.get(proposal.id)).toEqual(target);
      targets.recordRef(proposal.id, { ...ref, id: 'replacement' }, 200, undefined, {
        model: 'other-model',
      });
      expect(receipt()).toHaveProperty('model', 'other-model');
      expect(receipt()).not.toHaveProperty('effort');
      targets.recordRef(proposal.id, { ...ref, id: 'unknown' }, 300);
      expect(receipt()).not.toHaveProperty('model');
      expect(receipt()).not.toHaveProperty('effort');
      targets.recordRef(proposal.id, ref, 400, undefined, { effort: 'low' });
      expect(receipt()).not.toHaveProperty('model');
      expect(receipt()).toHaveProperty('effort', 'low');
    } finally {
      db.close();
    }
  });

  test('upgrades legacy targets and persists observed configuration across a database restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-configuration-'));
    const path = join(directory, 'daemon.db');
    let db = new Database(path, { messageSearchIndexFlushIntervalMs: 0 });
    try {
      await db.initialize(createReactiveDatabase(db));
      propose(db);
      db.getDatabase().exec('ALTER TABLE neo_work_driver_targets DROP COLUMN actual_model');
      db.getDatabase().exec('ALTER TABLE neo_work_driver_targets DROP COLUMN actual_effort');
      db.getDatabase().prepare('DELETE FROM migration_markers WHERE key = ?').run('migration_362');
      db.close();
      db = new Database(path, { messageSearchIndexFlushIntervalMs: 0 });
      await db.initialize(createReactiveDatabase(db));
      const upgraded = new NeoWorkDriverTargetRepository(db.getDatabase());
      expect(upgraded.get(proposal.id)).toEqual(target);
      expect(upgraded.receipts([proposal.id])[0]).not.toHaveProperty('model');
      expect(upgraded.receipts([proposal.id])[0]).not.toHaveProperty('effort');
      upgraded.recordRef(proposal.id, ref, 123, 'codex://threads/thread-1', {
        model: 'gpt-6.1-sol',
        effort: 'medium',
      });
      db.close();
      db = new Database(path, { messageSearchIndexFlushIntervalMs: 0 });
      await db.initialize(createReactiveDatabase(db));
      const reopened = new NeoWorkDriverTargetRepository(db.getDatabase());
      expect(reopened.readRef(proposal.id)).toEqual(ref);
      expect(reopened.readStartedAt(proposal.id)).toBe(123);
      expect(reopened.receipts([proposal.id])[0]).toMatchObject({
        link: 'codex://threads/thread-1',
        model: 'gpt-6.1-sol',
        effort: 'medium',
      });
      expect(reopened.get(proposal.id)).toEqual(target);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
