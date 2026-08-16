import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { resolveAgentFamily } from '../../../../src/lib/space/agents/agent-family-resolver.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpace(db: BunDatabase, id: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(id, `/tmp/${id}`, id, id, Date.now(), Date.now());
}

function seedWorker(db: BunDatabase, id: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, handle, status, description, model, tools,
     system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', '', null, '[]', '', ?, ?)`
  ).run(id, spaceId, id, id, Date.now(), Date.now());
}

function makeResolver(db: BunDatabase) {
  return {
    spaceAgentManager: new SpaceAgentManager(new SpaceAgentRepository(db)),
    longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
  };
}

describe('agent-family resolver', () => {
  test('classifies worker-only, long-horizon-only, shared, cross-space, and missing ids', () => {
    const db = makeDb();
    seedSpace(db, 'space-a');
    seedSpace(db, 'space-b');
    seedWorker(db, 'worker-only', 'space-a');
    seedWorker(db, 'shared-id', 'space-a');
    seedWorker(db, 'cross-worker', 'space-b');
    const repos = makeResolver(db);
    repos.longHorizonAgentRepo.create({
      id: 'lh-only',
      spaceId: 'space-a',
      handle: 'lh-only',
      displayName: 'LH Only',
    });
    repos.longHorizonAgentRepo.create({
      id: 'shared-id',
      spaceId: 'space-a',
      handle: 'shared-id',
      displayName: 'Shared',
    });

    expect(
      resolveAgentFamily({
        spaceId: 'space-a',
        agentId: 'worker-only',
        expected: 'worker',
        ...repos,
      })
    ).toMatchObject({
      classification: 'worker_only',
      ok: true,
      sharedId: false,
    });
    expect(
      resolveAgentFamily({
        spaceId: 'space-a',
        agentId: 'lh-only',
        expected: 'long_horizon',
        ...repos,
      })
    ).toMatchObject({
      classification: 'long_horizon_only',
      ok: true,
      sharedId: false,
    });
    expect(
      resolveAgentFamily({ spaceId: 'space-a', agentId: 'shared-id', expected: 'worker', ...repos })
    ).toMatchObject({
      classification: 'shared',
      ok: true,
      sharedId: true,
    });
    expect(
      resolveAgentFamily({
        spaceId: 'space-a',
        agentId: 'cross-worker',
        expected: 'worker',
        ...repos,
      })
    ).toMatchObject({
      classification: 'cross_space',
      ok: false,
      error: 'Agent not found: cross-worker',
    });
    expect(
      resolveAgentFamily({ spaceId: 'space-a', agentId: 'missing', expected: 'worker', ...repos })
    ).toMatchObject({
      classification: 'missing',
      ok: false,
      error: 'Agent not found: missing',
    });
    db.close();
  });

  test('returns deterministic wrong-family errors', () => {
    const db = makeDb();
    seedSpace(db, 'space-a');
    seedWorker(db, 'worker-only', 'space-a');
    const repos = makeResolver(db);
    repos.longHorizonAgentRepo.create({
      id: 'lh-only',
      spaceId: 'space-a',
      handle: 'lh-only',
      displayName: 'LH Only',
    });

    expect(
      resolveAgentFamily({
        spaceId: 'space-a',
        agentId: 'worker-only',
        expected: 'long_horizon',
        ...repos,
      })
    ).toMatchObject({
      ok: false,
      error: 'Expected long-horizon agent id, got worker agent id.',
    });
    expect(
      resolveAgentFamily({ spaceId: 'space-a', agentId: 'lh-only', expected: 'worker', ...repos })
    ).toMatchObject({
      ok: false,
      error: 'Expected worker agent id, got long-horizon agent id.',
    });
    db.close();
  });
});
