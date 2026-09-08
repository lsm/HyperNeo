import { beforeEach, describe, expect, test } from 'bun:test';
import type {
  CreateSpaceAgentTemplateParams,
  ModelInfo,
  SpaceAgentTemplate,
} from '@hyperneo/shared';
import { setModelsCache } from '../../../../src/lib/model-service';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../../../../src/lib/space/agents/worker-long-horizon-mapper';
import {
  runCreateTemplate,
  runDeleteTemplate,
  runUpdateTemplate,
  SpaceAgentTemplateManager,
} from '../../../../src/lib/space/managers/space-agent-template-manager';
import { SpaceAgentTemplateRepository } from '../../../../src/storage/repositories/space-agent-template-repository';
import { createSpaceAgentTemplatesTable } from '../../../../src/storage/schema/space-agent-templates';
import { runMigration226 } from '../../../../src/storage/schema/m226-space-agent-templates-version';
import { runMigration227 } from '../../../../src/storage/schema/m227-space-agent-template-version-seq';
import { runMigration238 } from '../../../../src/storage/schema/m238-space-agent-template-labels';
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
    labels: [],
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
    runMigration226(db);
    runMigration227(db);
    runMigration238(db);
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

    test('a stored row with a built-in key never shadows the built-in', () => {
      repo.create({
        key: 'builtin.default',
        handle: 'builtin-override',
        displayName: 'Override',
      });

      const templates = manager.list().filter((template) => template.key === 'builtin.default');
      expect(templates).toHaveLength(1);
      expect(templates[0]?.displayName).toBe('Built-in');
    });

    test('orders by createdAt then key', () => {
      repo.create({ key: 'b.custom', handle: 'b' });
      repo.create({ key: 'a.custom', handle: 'a' });
      db.prepare(`UPDATE space_agent_templates SET created_at = ? WHERE key IN (?, ?)`).run(
        1000,
        'a.custom',
        'b.custom'
      );

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

    test('rejects a blank display name', async () => {
      const result = await manager.create({ ...fullParams(), displayName: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('display name');
    });

    test('rejects a display name with only whitespace', async () => {
      const result = await manager.create({ ...fullParams(), displayName: '   ' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('display name');
    });

    test('creates a template with trimmed and deduplicated labels', async () => {
      const result = await manager.create({
        ...fullParams(),
        labels: [' release ', 'quality', 'release'],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.labels).toEqual(['release', 'quality']);
    });

    test('defaults labels to an empty array', async () => {
      const result = await manager.create(fullParams());

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.labels).toEqual([]);
    });

    test('rejects a blank label', async () => {
      const result = await manager.create({ ...fullParams(), labels: ['quality', '   '] });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('blank');
    });

    test('rejects labels with non-printable characters', async () => {
      const result = await manager.create({ ...fullParams(), labels: ['bad\u0007label'] });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('printable');
    });

    test('rejects invisible formatting characters in labels', async () => {
      for (const label of [
        'zero\u200Bwidth',
        'bi\u202Edi',
        'line\u2028sep',
        'lone\uD800pair',
        'non\uFDD0char',
        'plane\uFFFFend',
        'private\uE000use',
        'variation\uFE0Fselector',
        'hangul\u3164filler',
      ]) {
        const result = await manager.create({ ...fullParams(), labels: [label] });
        expect(result.ok, label).toBe(false);
        if (!result.ok) expect(result.error).toContain('printable');
      }
    });

    test('rejects a non-array labels payload', async () => {
      const result = await manager.create({
        ...fullParams(),
        labels: 'ops' as unknown as string[],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('array');
    });

    test('deduplicates canonically equivalent labels via NFC', async () => {
      const result = await manager.create({
        ...fullParams(),
        labels: ['caf\u00E9', 'cafe\u0301'],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.labels).toEqual(['caf\u00E9']);
    });

    test('rejects labels longer than 64 characters', async () => {
      const result = await manager.create({
        ...fullParams(),
        labels: ['x'.repeat(65)],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('limited to 64 characters');
    });

    test('rejects oversized label arrays before iterating', async () => {
      const labels = Array.from({ length: 20_000 }, (_, i) => `label-${i}`);

      const result = await manager.create({ ...fullParams(), labels });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('limited to 64 entries');
    });

    test('rejects duplicate-heavy label arrays before iterating', async () => {
      const labels = Array.from({ length: 100_000 }, () => 'duplicate');

      const result = await manager.create({ ...fullParams(), labels });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('limited to 64 entries');
    });

    test('rejects more than eight labels after dedupe', async () => {
      const result = await manager.create({
        ...fullParams(),
        labels: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'a'],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('limited to 8');
    });

    test('accepts up to eight labels', async () => {
      const result = await manager.create({
        ...fullParams(),
        labels: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'a'],
      });

      expect(result.ok).toBe(true);
    });

    test('rejects non-string labels', async () => {
      const result = await manager.create({
        ...fullParams(),
        labels: [1] as unknown as string[],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('strings');
    });

    test('rejects the reserved migration template key', async () => {
      const result = await manager.create({
        ...fullParams(),
        key: MIGRATED_WORKER_TEMPLATE_KEY,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('reserved');
    });

    test('rejects keys reserved for code built-in templates', async () => {
      for (const key of ['worker.coder', 'worker.reviewer', 'coordinator.default']) {
        const result = await manager.create({ ...fullParams(), key });
        expect(result.ok, key).toBe(false);
        if (!result.ok) expect(result.error).toContain('reserved for a built-in agent template');
      }
    });

    test('rejects a blank model', async () => {
      setModelsCache(
        new Map([['global', [makeModelInfo('claude-opus-5', 'claude-opus-5', 'anthropic')]]])
      );

      const result = await manager.create({ ...fullParams(), model: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/model/i);
    });

    test('rejects a blank provider', async () => {
      setModelsCache(
        new Map([['global', [makeModelInfo('claude-opus-5', 'claude-opus-5', 'anthropic')]]])
      );

      const result = await manager.create({ ...fullParams(), provider: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/provider/i);
    });

    test('rejects a blank model-pool provider', async () => {
      setModelsCache(
        new Map([['global', [makeModelInfo('claude-opus-5', 'claude-opus-5', 'anthropic')]]])
      );

      const result = await manager.create({
        ...fullParams(),
        model: undefined,
        provider: undefined,
        modelPool: [{ model: 'claude-opus-5', provider: '', maxConcurrent: 1, weight: 1 }],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/provider/i);
    });

    test('rejects a model-pool entry missing a model', async () => {
      const result = await manager.create({
        ...fullParams(),
        model: undefined,
        provider: undefined,
        modelPool: [{ provider: 'anthropic', maxConcurrent: 1, weight: 1 } as any],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/Model pool entries must specify a model/);
    });

    test('rejects a model pool entry with an incompatible provider', async () => {
      setModelsCache(new Map([['global', [makeModelInfo('glm-4-flash', 'glm-4-flash', 'glm')]]]));

      const result = await manager.create({
        ...fullParams(),
        model: undefined,
        provider: undefined,
        modelPool: [{ model: 'glm-4-flash', provider: 'anthropic', maxConcurrent: 1, weight: 1 }],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/anthropic/);
    });

    test('accepts a model pool entry with a compatible provider', async () => {
      setModelsCache(new Map([['global', [makeModelInfo('glm-4-flash', 'glm-4-flash', 'glm')]]]));

      const result = await manager.create({
        ...fullParams(),
        model: undefined,
        provider: undefined,
        modelPool: [{ model: 'glm-4-flash', provider: 'glm', maxConcurrent: 1, weight: 1 }],
      });

      expect(result.ok).toBe(true);
    });

    test('allows an empty model pool', async () => {
      const result = await manager.create({ ...fullParams(), modelPool: [] });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.modelPool).toBeNull();
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

    test('updates labels with trimming and dedupe', async () => {
      await manager.create({ ...fullParams(), labels: ['quality'] });

      const result = await manager.update('release-readiness.custom', {
        labels: [' infra ', 'infra', 'release'],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value?.labels).toEqual(['infra', 'release']);
    });

    test('leaves labels untouched when omitted on update', async () => {
      await manager.create({ ...fullParams(), labels: ['quality'] });

      const result = await manager.update('release-readiness.custom', {
        displayName: 'Renamed',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value?.labels).toEqual(['quality']);
    });

    test('clears labels with an explicit empty array or null', async () => {
      await manager.create({ ...fullParams(), labels: ['quality'] });

      const emptied = await manager.update('release-readiness.custom', { labels: [] });
      expect(emptied.ok).toBe(true);
      if (!emptied.ok) throw new Error('expected ok');
      expect(emptied.value?.labels).toEqual([]);

      const refilled = await manager.update('release-readiness.custom', { labels: ['ops'] });
      expect(refilled.ok).toBe(true);

      const nulled = await manager.update('release-readiness.custom', { labels: null });
      expect(nulled.ok).toBe(true);
      if (!nulled.ok) throw new Error('expected ok');
      expect(nulled.value?.labels).toEqual([]);
    });

    test('rejects a blank label on update', async () => {
      await manager.create(fullParams());

      const result = await manager.update('release-readiness.custom', { labels: [''] });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('blank');
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

    test('rejects a blank display name on update', async () => {
      await manager.create(fullParams());

      const result = await manager.update('release-readiness.custom', { displayName: '   ' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('display name');
    });

    test('rejects a blank model on update', async () => {
      setModelsCache(
        new Map([['global', [makeModelInfo('claude-opus-5', 'claude-opus-5', 'anthropic')]]])
      );
      await manager.create(fullParams());

      const result = await manager.update('release-readiness.custom', { model: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/model/i);
    });

    test('rejects a blank provider on update', async () => {
      setModelsCache(
        new Map([['global', [makeModelInfo('claude-opus-5', 'claude-opus-5', 'anthropic')]]])
      );
      await manager.create(fullParams());

      const result = await manager.update('release-readiness.custom', { provider: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/provider/i);
    });

    test('rejects a model-only update that is incompatible with the existing provider', async () => {
      setModelsCache(
        new Map([['global', [makeModelInfo('claude-sonnet-4-6', 'sonnet', 'anthropic')]]])
      );

      await manager.create({
        ...fullParams(),
        model: 'sonnet',
        provider: 'anthropic',
        modelPool: undefined,
      });

      const result = await manager.update('release-readiness.custom', { model: 'unknown-model' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/anthropic/);
    });

    test('validates a new model without a provider when provider is set to null', async () => {
      setModelsCache(
        new Map([
          [
            'global',
            [
              makeModelInfo('claude-sonnet-4-6', 'sonnet', 'anthropic'),
              makeModelInfo('glm-4-flash', 'glm-4-flash', 'glm'),
            ],
          ],
        ])
      );

      await manager.create({
        ...fullParams(),
        model: 'sonnet',
        provider: 'anthropic',
        modelPool: undefined,
      });

      const result = await manager.update('release-readiness.custom', {
        model: 'glm-4-flash',
        provider: null,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value?.model).toBe('glm-4-flash');
    });

    test('rejects a provider-only update that is incompatible with the existing model', async () => {
      setModelsCache(new Map([['global', [makeModelInfo('glm-4-flash', 'glm-4-flash', 'glm')]]]));

      await manager.create({
        ...fullParams(),
        model: 'glm-4-flash',
        provider: 'glm',
        modelPool: undefined,
      });

      const result = await manager.update('release-readiness.custom', { provider: 'anthropic' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/anthropic/);
    });

    test('accepts a provider-only update that is compatible with the existing model', async () => {
      setModelsCache(
        new Map([
          [
            'global',
            [
              makeModelInfo('shared-model', 'shared-model', 'anthropic'),
              makeModelInfo('shared-model', 'shared-model', 'glm'),
            ],
          ],
        ])
      );

      await manager.create({
        ...fullParams(),
        model: 'shared-model',
        provider: 'glm',
        modelPool: undefined,
      });

      const result = await manager.update('release-readiness.custom', { provider: 'anthropic' });

      expect(result.ok).toBe(true);
    });

    test('allows an empty model pool to clear the stored pool', async () => {
      await manager.create(fullParams());

      const result = await manager.update('release-readiness.custom', { modelPool: [] });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value?.modelPool).toBeNull();
    });

    test('rejects a model pool with an incompatible provider on update', async () => {
      setModelsCache(
        new Map([
          [
            'global',
            [
              makeModelInfo('claude-sonnet-4-6', 'sonnet', 'anthropic'),
              makeModelInfo('glm-4-flash', 'glm-4-flash', 'glm'),
            ],
          ],
        ])
      );

      await manager.create({
        ...fullParams(),
        model: 'sonnet',
        provider: 'anthropic',
        modelPool: undefined,
      });

      const result = await manager.update('release-readiness.custom', {
        modelPool: [{ model: 'glm-4-flash', provider: 'anthropic', maxConcurrent: 1, weight: 1 }],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/anthropic/);
    });

    test('accepts a model pool with a compatible provider on update', async () => {
      setModelsCache(
        new Map([
          [
            'global',
            [
              makeModelInfo('claude-sonnet-4-6', 'sonnet', 'anthropic'),
              makeModelInfo('glm-4-flash', 'glm-4-flash', 'glm'),
            ],
          ],
        ])
      );

      await manager.create({
        ...fullParams(),
        model: 'sonnet',
        provider: 'anthropic',
        modelPool: undefined,
      });

      const result = await manager.update('release-readiness.custom', {
        modelPool: [{ model: 'glm-4-flash', provider: 'glm', maxConcurrent: 1, weight: 1 }],
      });

      expect(result.ok).toBe(true);
    });

    test('prevents concurrent model and provider updates from persisting an unvalidated pair', async () => {
      setModelsCache(
        new Map([
          [
            'global',
            [
              makeModelInfo('shared-model', 'shared-model', 'anthropic'),
              makeModelInfo('shared-model', 'shared-model', 'glm'),
              makeModelInfo('glm-4-flash', 'glm-4-flash', 'glm'),
            ],
          ],
        ])
      );

      await manager.create({
        ...fullParams(),
        model: 'shared-model',
        provider: 'glm',
        modelPool: undefined,
      });

      const [modelResult, providerResult] = await Promise.all([
        manager.update('release-readiness.custom', { model: 'glm-4-flash' }),
        manager.update('release-readiness.custom', { provider: 'anthropic' }),
      ]);

      expect(modelResult.ok).toBe(true);
      expect(providerResult.ok).toBe(true);
      if (providerResult.ok) {
        expect(providerResult.value).toBeNull();
      }

      const final = manager.getByKey('release-readiness.custom');
      expect(final?.model).toBe('glm-4-flash');
      expect(final?.provider).toBe('glm');
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

  describe('create pipeline', () => {
    test('halts before persist on an invalid key', async () => {
      const ctx = await runCreateTemplate({ repo, params: { ...fullParams(), key: '' } });

      expect(ctx.error).toContain('key');
      expect(ctx.template).toBeUndefined();
      expect(repo.getByKey('')).toBeNull();
    });

    test('halts before persist on a duplicate key', async () => {
      await runCreateTemplate({ repo, params: fullParams() });

      const ctx = await runCreateTemplate({ repo, params: fullParams() });

      expect(ctx.error).toContain('already exists');
      expect(ctx.template).toBeUndefined();
    });

    test('halts before persist on a model pool with an incompatible provider', async () => {
      setModelsCache(new Map([['global', [makeModelInfo('glm-4-flash', 'glm-4-flash', 'glm')]]]));

      const ctx = await runCreateTemplate({
        repo,
        params: {
          ...fullParams(),
          model: undefined,
          provider: undefined,
          modelPool: [{ model: 'glm-4-flash', provider: 'anthropic', maxConcurrent: 1, weight: 1 }],
        },
      });

      expect(ctx.error).toMatch(/anthropic/);
      expect(ctx.template).toBeUndefined();
      expect(repo.getByKey('release-readiness.custom')).toBeNull();
    });
  });

  describe('update pipeline', () => {
    test('halts before persist for an unknown key', async () => {
      const ctx = await runUpdateTemplate({
        repo,
        key: 'missing.custom',
        params: { displayName: 'X' },
      });

      expect(ctx.error).toContain('not found');
      expect(ctx.template).toBeUndefined();
    });

    test('halts before persist on an invalid model', async () => {
      setModelsCache(
        new Map([['global', [makeModelInfo('claude-opus-5', 'claude-opus-5', 'anthropic')]]])
      );
      await manager.create(fullParams());

      const ctx = await runUpdateTemplate({
        repo,
        key: 'release-readiness.custom',
        params: { model: 'unknown-model' },
      });

      expect(ctx.error).toMatch(/Unrecognized model/);
      expect(ctx.template).toBeUndefined();
    });

    test('detects a superseded write without persisting a stale combination', async () => {
      await runCreateTemplate({ repo, params: fullParams() });

      const [first, second] = await Promise.all([
        runUpdateTemplate({
          repo,
          key: 'release-readiness.custom',
          params: { displayName: 'First' },
        }),
        runUpdateTemplate({
          repo,
          key: 'release-readiness.custom',
          params: { displayName: 'Second' },
        }),
      ]);

      const winner = first.template ?? second.template;
      const loser = first.template ? second : first;

      expect(winner).toBeDefined();
      expect(loser.error).toBeUndefined();
      expect(loser.template).toBeNull();
    });
  });

  describe('delete pipeline', () => {
    test('halts before delete for an unknown key', () => {
      const ctx = runDeleteTemplate({ repo, key: 'missing.custom' });

      expect(ctx.error).toContain('not found');
      expect(ctx.deleted).toBeUndefined();
    });

    test('deletes the existing template', async () => {
      await manager.create(fullParams());

      const ctx = runDeleteTemplate({ repo, key: 'release-readiness.custom' });

      expect(ctx.error).toBeUndefined();
      expect(ctx.deleted).toBe(true);
      expect(repo.getByKey('release-readiness.custom')).toBeNull();
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

    test('a stored row with a built-in key never shadows the built-in', async () => {
      repo.create({
        key: 'builtin.default',
        handle: 'builtin-override',
        displayName: 'Override',
      });

      const template = manager.getByKey('builtin.default');
      expect(template?.displayName).toBe('Built-in');
    });

    test('worker built-ins keep their tool policy through the template view', () => {
      const defaultManager = new SpaceAgentTemplateManager(repo);
      const template = defaultManager.getByKey('worker.reviewer');
      expect(template?.tools).toContain('Read');
      expect(template?.tools).toContain('Bash(gh pr view:*)');
      expect(template?.tools).not.toContain('Bash');

      const coder = defaultManager.getByKey('worker.coder');
      expect(coder?.tools).toBeNull();
    });

    test('long-horizon built-ins still expose no tools', () => {
      const defaultManager = new SpaceAgentTemplateManager(repo);
      const template = defaultManager.getByKey('coordinator.default');
      expect(template?.tools).toBeNull();
    });

    test('returns null for an unknown key', () => {
      expect(manager.getByKey('missing.custom')).toBeNull();
    });
  });
});
