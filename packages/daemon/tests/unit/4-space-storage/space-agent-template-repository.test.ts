import { beforeEach, describe, expect, test } from 'bun:test';
import type {
  CreateSpaceAgentTemplateParams,
  SpaceAgentAutonomyLevel,
  SpaceAgentTemplate,
  AgentModelPoolEntry,
} from '@hyperneo/shared';
import { SpaceAgentTemplateRepository } from '../../../src/storage/repositories/space-agent-template-repository';
import { createSpaceAgentTemplatesTable } from '../../../src/storage/schema/space-agent-templates';
import { runMigration226 } from '../../../src/storage/schema/m226-space-agent-templates-version';
import { runMigration227 } from '../../../src/storage/schema/m227-space-agent-template-version-seq';
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
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
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
    });
    expect(emptied!.settingSources).toEqual([]);
    expect(emptied!.modelPool).toBeNull();
    expect(emptied!.tools).toBeNull();

    const inherited = repo.update('release-readiness.custom', { settingSources: null });
    expect(inherited!.settingSources).toBeNull();
  });

  test('update with no fields returns the current row unchanged', () => {
    const created = repo.create(fullParams());
    expect(repo.update('release-readiness.custom', {})).toEqual(created);
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
