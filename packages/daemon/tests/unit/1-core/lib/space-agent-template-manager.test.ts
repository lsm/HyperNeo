import { beforeEach, describe, expect, test } from 'bun:test';
import type {
  CreateSpaceAgentTemplateParams,
  ModelInfo,
  SpaceAgentTemplate,
} from '@hyperneo/shared';
import { SpaceAgentTemplateManager } from '../../../../src/lib/space/managers/space-agent-template-manager';
import { setModelsCache } from '../../../../src/lib/model-service';
import { SpaceAgentTemplateRepository } from '../../../../src/storage/repositories/space-agent-template-repository';
import { createSpaceAgentTemplatesTable } from '../../../../src/storage/schema/space-agent-templates';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const BUILT_INS: SpaceAgentTemplate[] = [
  {
    key: 'builtin.default',
    handle: 'builtin',
    displayName: 'Built-in',
    description: 'A built-in template.',
    instructions: 'Built-in instructions.',
    suggestedAutonomyLevel: 2,
    model: null,
    provider: null,
    modelPool: null,
    thinkingLevel: null,
    settingSources: null,
    tools: null,
    createdAt: 0,
    updatedAt: 0,
  },
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
    modelPool: [{ model: 'claude-opus-5', provider: 'anthropic', maxConcurrent: 2, weight: 3 }],
    thinkingLevel: 'think16k',
    settingSources: ['user', 'project'],
    tools: ['Read', 'Grep', 'Glob'],
  };
}

function makeModelInfo(id: string, alias: string, provider = 'anthropic'): ModelInfo {
  return {
    id,
    alias,
    name: id,
    family: 'claude' as const,
    provider,
    contextWindow: 200000,
    description: '',
    releaseDate: '2025-01-01',
    available: true,
  };
}

describe('SpaceAgentTemplateManager', () => {
  let db: BunDatabase;
  let repo: SpaceAgentTemplateRepository;
  let manager: SpaceAgentTemplateManager;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceAgentTemplatesTable(db);
    repo = new SpaceAgentTemplateRepository(db);
    manager = new SpaceAgentTemplateManager(repo, () => BUILT_INS);
    setModelsCache(new Map());
  });

  describe('list', () => {
    test('includes built-in templates', () => {
      expect(manager.list().some((template) => template.key === 'builtin.default')).toBe(true);
    });

    test('merges custom templates with built-ins by key', () => {
      const created = repo.create(fullParams());

      const templates = manager.list();
      expect(templates.some((template) => template.key === 'release-readiness.custom')).toBe(true);
      expect(templates.some((template) => template.key === 'builtin.default')).toBe(true);

      const custom = templates.find((template) => template.key === 'release-readiness.custom');
      expect(custom).toEqual(created);
    });

    test('custom template with the same key overrides the built-in', () => {
      repo.create({
        key: 'builtin.default',
        handle: 'builtin-override',
        displayName: 'Override',
      });

      const override = manager.list().find((template) => template.key === 'builtin.default');
      expect(override?.displayName).toBe('Override');
    });

    test('orders by createdAt then key', () => {
      repo.create({ key: 'b.custom', handle: 'b' });
      repo.create({ key: 'a.custom', handle: 'a' });

      const keys = manager.list().map((template) => template.key);
      const aIndex = keys.indexOf('a.custom');
      const bIndex = keys.indexOf('b.custom');
      expect(aIndex).toBeLessThan(bIndex);
    });
  });

  describe('create', () => {
    test('creates a valid custom template', async () => {
      const result = await manager.create(fullParams());

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.key).toBe('release-readiness.custom');
      expect(manager.getByKey('release-readiness.custom')).not.toBeNull();
    });

    test('rejects a duplicate key', async () => {
      await manager.create(fullParams());
      const result = await manager.create(fullParams());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('already exists');
    });

    test('rejects an empty key', async () => {
      const result = await manager.create({ ...fullParams(), key: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('key');
    });

    test('rejects a key with leading whitespace', async () => {
      const result = await manager.create({ ...fullParams(), key: ' bad' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('key');
    });

    test('rejects an invalid handle', async () => {
      const result = await manager.create({ ...fullParams(), handle: 'Bad Handle!' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('handle');
    });

    test('rejects an invalid autonomy level', async () => {
      const result = await manager.create({
        ...fullParams(),
        suggestedAutonomyLevel: 6 as 1 | 2 | 3 | 4 | 5,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('autonomy');
    });

    test('rejects unknown tools', async () => {
      const result = await manager.create({ ...fullParams(), tools: ['FakeTool'] });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('FakeTool');
    });

    test('rejects an unrecognized model when the cache is populated', async () => {
      setModelsCache(
        new Map([['global', [makeModelInfo('claude-sonnet-4-6', 'sonnet', 'anthropic')]]])
      );

      const result = await manager.create({ ...fullParams(), model: 'unknown-model' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/Unrecognized model/);
    });

    test('skips model validation when the cache is empty', async () => {
      const result = await manager.create({ ...fullParams(), model: 'future-model' });

      expect(result.ok).toBe(true);
    });
  });

  describe('update', () => {
    test('updates a custom template', async () => {
      await manager.create(fullParams());

      const result = await manager.update('release-readiness.custom', {
        displayName: 'Updated',
        instructions: 'New instructions.',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value?.displayName).toBe('Updated');
      expect(result.value?.instructions).toBe('New instructions.');
    });

    test('returns an error for an unknown key', async () => {
      const result = await manager.update('missing.custom', { displayName: 'X' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('not found');
    });

    test('rejects an invalid handle on update', async () => {
      await manager.create(fullParams());

      const result = await manager.update('release-readiness.custom', { handle: 'bad handle' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('handle');
    });

    test('rejects unknown tools on update', async () => {
      await manager.create(fullParams());

      const result = await manager.update('release-readiness.custom', { tools: ['FakeTool'] });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('FakeTool');
    });
  });

  describe('delete', () => {
    test('deletes a custom template', async () => {
      await manager.create(fullParams());

      const result = manager.delete('release-readiness.custom');

      expect(result.ok).toBe(true);
      expect(manager.getByKey('release-readiness.custom')).toBeNull();
    });

    test('returns an error for an unknown key', () => {
      const result = manager.delete('missing.custom');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('not found');
    });

    test('cannot delete a built-in', () => {
      const result = manager.delete('builtin.default');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('not found');
    });
  });

  describe('getByKey', () => {
    test('returns a built-in template by key', () => {
      const template = manager.getByKey('builtin.default');
      expect(template?.displayName).toBe('Built-in');
    });

    test('returns a custom template by key', async () => {
      await manager.create(fullParams());

      const template = manager.getByKey('release-readiness.custom');
      expect(template?.displayName).toBe('Release Readiness');
    });

    test('custom template with the same key shadows the built-in', async () => {
      repo.create({
        key: 'builtin.default',
        handle: 'builtin-override',
        displayName: 'Override',
      });

      const template = manager.getByKey('builtin.default');
      expect(template?.displayName).toBe('Override');
    });

    test('returns null for an unknown key', () => {
      expect(manager.getByKey('missing.custom')).toBeNull();
    });
  });
});
