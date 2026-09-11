import { beforeEach, describe, expect, test } from 'bun:test';
import type {
  AgentModelPoolEntry,
  CreateSpaceAgentTemplateParams,
  SpaceAgentAutonomyLevel,
  SpaceAgentTemplate,
} from '@hyperneo/shared';
import { SpaceAgentTemplateRepository } from '../../../src/storage/repositories/space-agent-template-repository';
import { createSpaceAgentTemplatesTable } from '../../../src/storage/schema/space-agent-templates';
import { runMigration226 } from '../../../src/storage/schema/m226-space-agent-templates-version';
import { runMigration227 } from '../../../src/storage/schema/m227-space-agent-template-version-seq';
import { runMigration238 } from '../../../src/storage/schema/m238-space-agent-template-labels';
import { runMigration243 } from '../../../src/storage/schema/m243-space-agent-template-space-key';
import { Database as BunDatabase } from '../../../src/storage/sqlite-compat';

const MODEL_POOL: AgentModelPoolEntry[] = [
  { model: 'claude-opus-5', provider: 'anthropic', maxConcurrent: 2, weight: 3 },
  { model: 'claude-sonnet-5', maxConcurrent: 4, weight: 1 },
];

function fullParams(): CreateSpaceAgentTemplateParams {
  return {
    key: 'release-readiness.custom',
    handle: 'release-readiness',
    displayName: 'Release Readiness',
    description: 'Tracks release readiness signals.',
    instructions: 'Coordinate release checks.',
    suggestedAutonomyLevel: 3,
    model: 'claude-opus-5',
    provider: 'anthropic',
    modelPool: MODEL_POOL,
    thinkingLevel: 'think16k',
    settingSources: ['user', 'project'],
    tools: ['Read', 'Grep', 'Glob'],
    labels: ['quality', 'release'],
  };
}

describe('SpaceAgentTemplateRepository', () => {
  let repo: SpaceAgentTemplateRepository;
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceAgentTemplatesTable(db);
    runMigration226(db);
    runMigration227(db);
    runMigration238(db);
    repo = new SpaceAgentTemplateRepository(db);
  });

  test('create persists the full column set and getByKey round-trips it', () => {
    const created = repo.create(fullParams());

    expect(created).toEqual({
      key: 'release-readiness.custom',
      handle: 'release-readiness',
      displayName: 'Release Readiness',
      description: 'Tracks release readiness signals.',
      instructions: 'Coordinate release checks.',
      suggestedAutonomyLevel: 3,
      model: 'claude-opus-5',
      provider: 'anthropic',
      modelPool: MODEL_POOL,
      thinkingLevel: 'think16k',
      settingSources: ['user', 'project'],
      tools: ['Read', 'Grep', 'Glob'],
      labels: ['quality', 'release'],
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
      version: 1,
    } satisfies SpaceAgentTemplate);
    expect(repo.getByKey('release-readiness.custom')).toEqual(created);
  });

  test('create applies defaults for omitted optional fields', () => {
    const created = repo.create({ key: 'notes.custom', handle: 'notes' });

    expect(created.displayName).toBe('notes');
    expect(created.description).toBe('');
    expect(created.instructions).toBe('');
    expect(created.suggestedAutonomyLevel).toBe(2);
    expect(created.model).toBeNull();
    expect(created.provider).toBeNull();
    expect(created.modelPool).toBeNull();
    expect(created.thinkingLevel).toBeNull();
    expect(created.settingSources).toBeNull();
    expect(created.tools).toBeNull();
    expect(created.labels).toEqual([]);
  });

  test('create normalizes empty modelPool and tools to null but preserves empty settingSources', () => {
    const created = repo.create({
      key: 'empty.custom',
      handle: 'empty',
      modelPool: [],
      settingSources: [],
      tools: [],
    });

    expect(created.modelPool).toBeNull();
    expect(created.tools).toBeNull();
    expect(created.settingSources).toEqual([]);
  });

  test('duplicate key violates the primary key constraint', () => {
    repo.create({ key: 'dup.custom', handle: 'dup' });
    expect(() => repo.create({ key: 'dup.custom', handle: 'other' })).toThrow(/UNIQUE constraint/i);
    expect(repo.list()).toHaveLength(1);
  });

  test('suggested autonomy outside 1-5 violates the CHECK constraint', () => {
    expect(() =>
      repo.create({
        key: 'low.custom',
        handle: 'low',
        suggestedAutonomyLevel: 0 as unknown as SpaceAgentAutonomyLevel,
      })
    ).toThrow(/CHECK constraint/i);
    expect(() =>
      repo.create({
        key: 'high.custom',
        handle: 'high',
        suggestedAutonomyLevel: 6 as unknown as SpaceAgentAutonomyLevel,
      })
    ).toThrow(/CHECK constraint/i);
    expect(repo.list()).toHaveLength(0);
  });

  test('getByKey returns null for unknown keys', () => {
    expect(repo.getByKey('missing.custom')).toBeNull();
  });

  test('list orders by created_at and breaks ties on key', () => {
    repo.create({ key: 'b.custom', handle: 'b' });
    repo.create({ key: 'a.custom', handle: 'a' });
    repo.create({ key: 'c.custom', handle: 'c' });
    db.prepare(`UPDATE space_agent_templates SET created_at = ?`).run(1000);

    expect(repo.list().map((t) => t.key)).toEqual(['a.custom', 'b.custom', 'c.custom']);

    db.prepare(`UPDATE space_agent_templates SET created_at = ? WHERE key = ?`).run(
      2000,
      'a.custom'
    );
    expect(repo.list().map((t) => t.key)).toEqual(['b.custom', 'c.custom', 'a.custom']);
  });

  test('update changes only the provided fields and bumps updated_at', () => {
    const created = repo.create(fullParams());

    const updated = repo.update('release-readiness.custom', {
      handle: 'release-readiness-v2',
      instructions: 'New instructions.',
      suggestedAutonomyLevel: 4,
    });

    expect(updated).not.toBeNull();
    expect(updated!.handle).toBe('release-readiness-v2');
    expect(updated!.instructions).toBe('New instructions.');
    expect(updated!.suggestedAutonomyLevel).toBe(4);
    expect(updated!.displayName).toBe(created.displayName);
    expect(updated!.model).toBe(created.model);
    expect(updated!.modelPool).toEqual(MODEL_POOL);
    expect(updated!.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  test('update replaces and clears JSON columns', () => {
    repo.create(fullParams());

    const updated = repo.update('release-readiness.custom', {
      modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 1, weight: 1 }],
      settingSources: ['local'],
      tools: ['Bash'],
    });
    expect(updated!.modelPool).toEqual([
      { model: 'claude-haiku-4-5', maxConcurrent: 1, weight: 1 },
    ]);
    expect(updated!.settingSources).toEqual(['local']);
    expect(updated!.tools).toEqual(['Bash']);

    const cleared = repo.update('release-readiness.custom', {
      modelPool: null,
      settingSources: null,
      tools: null,
    });
    expect(cleared!.modelPool).toBeNull();
    expect(cleared!.settingSources).toBeNull();
    expect(cleared!.tools).toBeNull();
  });

  test('update keeps the null-versus-empty contract per JSON column', () => {
    repo.create(fullParams());

    const emptied = repo.update('release-readiness.custom', {
      settingSources: [],
      modelPool: [],
      tools: [],
      labels: [],
    });
    expect(emptied!.settingSources).toEqual([]);
    expect(emptied!.modelPool).toBeNull();
    expect(emptied!.tools).toBeNull();
    expect(emptied!.labels).toEqual([]);

    const inherited = repo.update('release-readiness.custom', { settingSources: null });
    expect(inherited!.settingSources).toBeNull();
  });

  test('update replaces and clears labels and leaves them untouched when omitted', () => {
    repo.create(fullParams());

    const replaced = repo.update('release-readiness.custom', { labels: ['infra'] });
    expect(replaced!.labels).toEqual(['infra']);

    const untouched = repo.update('release-readiness.custom', { handle: 'release-readiness-v2' });
    expect(untouched!.labels).toEqual(['infra']);

    const cleared = repo.update('release-readiness.custom', { labels: null });
    expect(cleared!.labels).toEqual([]);
  });

  test('update with no fields returns the current row unchanged', () => {
    const created = repo.create(fullParams());
    expect(repo.update('release-readiness.custom', {})).toEqual(created);
  });

  test('casUpdate with no fields honors the expected version', () => {
    repo.create(fullParams());

    expect(repo.casUpdate('release-readiness.custom', {}, 999)).toBeNull();
    expect(repo.casUpdate('release-readiness.custom', {}, 1)?.key).toBe('release-readiness.custom');
    expect(repo.casUpdate('release-readiness.custom', {})).not.toBeNull();
  });

  test('update on an unknown key returns null', () => {
    expect(repo.update('missing.custom', { handle: 'x' })).toBeNull();
  });

  test('delete removes the row and frees the key for reuse', () => {
    repo.create({ key: 'gone.custom', handle: 'gone' });

    expect(repo.delete('missing.custom')).toBe(false);
    expect(repo.delete('gone.custom')).toBe(true);
    expect(repo.getByKey('gone.custom')).toBeNull();
    expect(repo.delete('gone.custom')).toBe(false);

    const recreated = repo.create({ key: 'gone.custom', handle: 'back' });
    expect(recreated.handle).toBe('back');
    expect(repo.list()).toHaveLength(1);
  });

  test('prevents a stale CAS update after delete and recreate', () => {
    repo.create({ key: 'reuse.custom', handle: 'reuse' });
    const before = repo.getByKeyWithVersion('reuse.custom')!;

    repo.delete('reuse.custom');
    repo.create({ key: 'reuse.custom', handle: 'reincarnated' });
    const after = repo.getByKeyWithVersion('reuse.custom')!;

    expect(after.version).not.toBe(before.version);
    const result = repo.casUpdate('reuse.custom', { displayName: 'Stale' }, before.version);
    expect(result).toBeNull();
    expect(repo.getByKey('reuse.custom')?.displayName).not.toBe('Stale');
  });
});

describe('SpaceAgentTemplateRepository — Space-scoped methods', () => {
  let repo: SpaceAgentTemplateRepository;
  let db: BunDatabase;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceAgentTemplatesTable(db);
    runMigration226(db);
    runMigration227(db);
    runMigration238(db);
    runMigration243(db);
    repo = new SpaceAgentTemplateRepository(db);
  });

  test('createOwned records the Space and getOwned reads it back', () => {
    repo.createOwned('space-a', { key: 'k', handle: 'h' });
    expect(repo.getOwned('space-a', 'k')?.handle).toBe('h');
  });

  test('a Space cannot see, update or delete another Space own row', () => {
    repo.createOwned('space-a', { key: 'k', handle: 'h' });

    expect(repo.getOwned('space-b', 'k')).toBeNull();
    expect(repo.casUpdateOwned('space-b', 'k', { displayName: 'X' })).toBeNull();
    expect(repo.deleteOwned('space-b', 'k')).toBe(false);
    expect(repo.getOwned('space-a', 'k')).not.toBeNull();
  });

  test('the owning Space can update and delete its own row', () => {
    repo.createOwned('space-a', { key: 'k', handle: 'h' });

    expect(repo.casUpdateOwned('space-a', 'k', { displayName: 'X' })?.displayName).toBe('X');
    expect(repo.deleteOwned('space-a', 'k')).toBe(true);
    expect(repo.getOwned('space-a', 'k')).toBeNull();
  });

  test('one key can exist in two Spaces independently', () => {
    repo.createOwned('space-a', { key: 'k', handle: 'a' });
    repo.createOwned('space-b', { key: 'k', handle: 'b' });

    expect(repo.getOwned('space-a', 'k')?.handle).toBe('a');
    expect(repo.getOwned('space-b', 'k')?.handle).toBe('b');
    expect(repo.deleteOwned('space-a', 'k')).toBe(true);
    expect(repo.getOwned('space-b', 'k')?.handle).toBe('b');
  });

  test('unmigrated rows at the sentinel stay visible to every Space', () => {
    repo.create({ key: 'legacy', handle: 'old' });

    expect(repo.getOwned('space-a', 'legacy')?.handle).toBe('old');
    expect(repo.getOwned('space-b', 'legacy')?.handle).toBe('old');
    expect(repo.listOwned('space-a').map((t) => t.key)).toContain('legacy');
  });

  test('an owned row wins over a sentinel row with the same key', () => {
    repo.create({ key: 'k', handle: 'sentinel' });
    repo.createOwned('space-a', { key: 'k', handle: 'owned' });

    expect(repo.getOwned('space-a', 'k')?.handle).toBe('owned');
    expect(repo.getOwned('space-b', 'k')?.handle).toBe('sentinel');
  });

  test('listOwned returns the Space own rows plus unmigrated ones', () => {
    repo.createOwned('space-a', { key: 'mine', handle: 'a' });
    repo.createOwned('space-b', { key: 'theirs', handle: 'b' });
    repo.create({ key: 'legacy', handle: 'old' });

    expect(
      repo
        .listOwned('space-a')
        .map((t) => t.key)
        .sort()
    ).toEqual(['legacy', 'mine']);
  });
  test('an update from one Space never rewrites the shared sentinel row', () => {
    repo.create({ key: 'k', handle: 'sentinel' });
    repo.createOwned('space-a', { key: 'k', handle: 'owned' });

    repo.casUpdateOwned('space-a', 'k', { displayName: 'Changed' });

    expect(repo.getOwned('space-a', 'k')?.displayName).toBe('Changed');
    expect(repo.getOwned('space-b', 'k')?.displayName).not.toBe('Changed');
  });

  test('deleting an owned row leaves the sentinel other Spaces still use', () => {
    repo.create({ key: 'k', handle: 'sentinel' });
    repo.createOwned('space-a', { key: 'k', handle: 'owned' });

    expect(repo.deleteOwned('space-a', 'k')).toBe(true);

    expect(repo.getOwned('space-a', 'k')?.handle).toBe('sentinel');
    expect(repo.getOwned('space-b', 'k')?.handle).toBe('sentinel');
  });

  test('a versioned write refuses when the version belongs to the shadowed row', () => {
    repo.create({ key: 'k', handle: 'sentinel' });
    const owned = repo.createOwned('space-a', { key: 'k', handle: 'owned' });
    const sentinelVersion = (owned.version ?? 1) + 99;

    expect(repo.casUpdateOwned('space-a', 'k', { displayName: 'X' }, sentinelVersion)).toBeNull();
    expect(repo.deleteOwned('space-a', 'k', sentinelVersion)).toBe(false);
  });

  test('listOwned reports one row per key when a sentinel is shadowed', () => {
    repo.create({ key: 'k', handle: 'sentinel' });
    repo.createOwned('space-a', { key: 'k', handle: 'owned' });

    const listed = repo.listOwned('space-a').filter((t) => t.key === 'k');
    expect(listed).toHaveLength(1);
    expect(listed[0].handle).toBe('owned');
  });

  test('writes and deletes are refused when the Space sees no row at all', () => {
    expect(repo.casUpdateOwned('space-a', 'missing', { displayName: 'X' })).toBeNull();
    expect(repo.deleteOwned('space-a', 'missing')).toBe(false);
  });
  test('dedupe keeps creation order when an owned row replaces an older sentinel', () => {
    repo.create({ key: 'shadowed', handle: 'sentinel' });
    repo.createOwned('space-a', { key: 'middle', handle: 'mid' });
    repo.createOwned('space-a', { key: 'shadowed', handle: 'owned' });

    expect(repo.listOwned('space-a').map((t) => t.key)).toEqual(['middle', 'shadowed']);
  });
  test('ties on created_at order by key the way SQLite does, not by locale', () => {
    const at = 5_000;
    for (const key of ['a.one', 'Z.one', '_.one']) {
      db.prepare(
        `INSERT INTO space_agent_templates
           (space_id, key, handle, display_name, description, instructions,
            suggested_autonomy_level, created_at, updated_at, version)
         VALUES ('space-a', ?, 'h', 'H', '', '', 2, ?, ?, 1)`
      ).run(key, at, at);
    }

    expect(repo.listOwned('space-a').map((t) => t.key)).toEqual(['Z.one', '_.one', 'a.one']);
  });
  test('ordering matches SQLite for keys outside the basic plane', () => {
    const at = 7_000;
    for (const key of ['\u{10000}.one', '\ue000.one']) {
      db.prepare(
        `INSERT INTO space_agent_templates
           (space_id, key, handle, display_name, description, instructions,
            suggested_autonomy_level, created_at, updated_at, version)
         VALUES ('space-a', ?, 'h', 'H', '', '', 2, ?, ?, 1)`
      ).run(key, at, at);
    }

    const viaSql = (
      db
        .prepare(
          `SELECT key FROM space_agent_templates WHERE space_id = 'space-a' AND created_at = ?
            ORDER BY created_at ASC, key ASC`
        )
        .all(at) as Array<{ key: string }>
    ).map((row) => row.key);

    expect(
      repo
        .listOwned('space-a')
        .filter((t) => t.key.endsWith('.one'))
        .map((t) => t.key)
    ).toEqual(viaSql);
  });
});
