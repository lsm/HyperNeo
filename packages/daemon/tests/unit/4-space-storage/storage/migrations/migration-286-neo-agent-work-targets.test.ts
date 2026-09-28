import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import { Database as DaemonDatabase } from '../../../../../src/storage/database.ts';
import { createReactiveDatabase } from '../../../../../src/storage/reactive-database.ts';
import { createNeoTables } from '../../../../../src/storage/schema/neo.ts';
import { runMigration283 } from '../../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration286 } from '../../../../../src/storage/schema/m286-neo-agent-work-targets.ts';
import { NeoRepository } from '../../../../../src/storage/repositories/neo-repository.ts';
import { NeoAgentWorkTargetRepository } from '../../../../../src/storage/repositories/neo-agent-work-target-repository.ts';

const proposal = {
  id: 'work-A',
  requestKey: 'A',
  concernId: null,
  originSessionId: 'root',
  originMessageId: 'ask-A',
  title: 'Approved later',
  instruction: 'No execution',
  targetSessionId: 'manager',
};
const agent = { spaceId: 'space:α/?', agentId: "manager:α';SELECT 1", sessionId: 'manager' };

describe('migration 286 and immutable agent targets', () => {
  test('missing Neo subsystem is not silently created', () => {
    const db = new Database(':memory:');
    try {
      runMigration286(db);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'neo_%'").all()).toEqual(
        []
      );
    } finally {
      db.close();
    }
  });
  test('additive migration is idempotent and preserves every legacy work field', () => {
    const db = new Database(':memory:');
    try {
      createNeoTables(db);
      runMigration283(db);
      const work = new NeoRepository(db).proposeWork(proposal);
      const before = db.prepare('SELECT * FROM neo_work').get();
      expect(new NeoAgentWorkTargetRepository(db).get(work.id)).toBeNull();
      runMigration286(db);
      runMigration286(db);
      expect(db.prepare('SELECT * FROM neo_work').get()).toEqual(before);
      expect(new NeoRepository(db).getWork(work.id)).toEqual(work);
      expect(new NeoAgentWorkTargetRepository(db).get(work.id)).toBeNull();
      expect(db.prepare('PRAGMA table_info(neo_agent_work_targets)').all()).toHaveLength(4);
    } finally {
      db.close();
    }
  });
  test('exact target reservation is immutable across retries and work transitions', () => {
    const db = new Database(':memory:');
    try {
      createNeoTables(db);
      runMigration283(db);
      runMigration286(db);
      const workRepo = new NeoRepository(db);
      const targets = new NeoAgentWorkTargetRepository(db);
      const work = workRepo.proposeWork(proposal);
      expect(targets.reserve(work.id, agent)).toEqual(agent);
      expect(targets.reserve(work.id, { ...agent, spaceId: 'other', agentId: 'other' })).toEqual(
        agent
      );
      expect(targets.reserve(work.id, { ...agent, sessionId: 'different' })).toEqual(agent);
      const queued = workRepo.transitionWork(work.id, work, {
        status: 'queued',
        sessionId: agent.sessionId,
      })!;
      expect(targets.reserve(work.id, agent)).toEqual(agent);
      expect(
        workRepo.transitionWork(work.id, queued, { status: 'reported', report: 'Claim only' })
      ).toMatchObject({ originMessageId: 'ask-A', targetSessionId: agent.sessionId });
      expect(targets.get(work.id)).toEqual(agent);
      expect(db.prepare('SELECT * FROM neo_agent_work_targets').all()).toHaveLength(1);
      expect(targets.get('other')).toBeNull();
    } finally {
      db.close();
    }
  });
  test.each(['missing', 'wrong', 'scratch', 'queued'])(
    'new binding refuses %s work without guessing',
    (kind) => {
      const db = new Database(':memory:');
      try {
        createNeoTables(db);
        runMigration283(db);
        runMigration286(db);
        const repo = new NeoRepository(db);
        const targets = new NeoAgentWorkTargetRepository(db);
        if (kind !== 'missing') {
          const work = repo.proposeWork({
            ...proposal,
            targetSessionId:
              kind === 'scratch' ? null : kind === 'wrong' ? 'other' : agent.sessionId,
          });
          if (kind === 'queued')
            repo.transitionWork(work.id, work, { status: 'queued', sessionId: agent.sessionId });
        }
        expect(targets.reserve(proposal.id, agent)).toBeNull();
        expect(db.prepare('SELECT * FROM neo_agent_work_targets').all()).toEqual([]);
      } finally {
        db.close();
      }
    }
  );
  test('actual migration runner upgrades a previous database without rewriting work', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neo-agent-target-upgrade-'));
    const path = join(directory, 'daemon.db');
    const first = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
    try {
      await first.initialize(createReactiveDatabase(first));
      new NeoRepository(first.getDatabase()).proposeWork(proposal);
      first.getDatabase().exec('DROP TABLE neo_agent_work_targets');
      first
        .getDatabase()
        .prepare('DELETE FROM migration_markers WHERE key = ?')
        .run('migration_286');
    } finally {
      first.close();
    }
    const reopened = new DaemonDatabase(path, { messageSearchIndexFlushIntervalMs: 0 });
    try {
      await reopened.initialize(createReactiveDatabase(reopened));
      expect(new NeoRepository(reopened.getDatabase()).getWork(proposal.id)).toMatchObject({
        ...proposal,
        status: 'proposed',
        sessionId: null,
      });
      expect(
        new NeoAgentWorkTargetRepository(reopened.getDatabase()).reserve(proposal.id, agent)
      ).toEqual(agent);
      expect(
        reopened
          .getDatabase()
          .prepare('SELECT key FROM migration_markers WHERE key = ?')
          .get('migration_286')
      ).toEqual({ key: 'migration_286' });
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
