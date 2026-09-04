import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager';
import { setModelsCache } from '../../../../src/lib/model-service';
import type { ModelInfo } from '@hyperneo/shared';
import {
  createSpaceAgentSchema,
  insertSpace,
  insertWorkflow,
  insertWorkflowNode,
} from '../../helpers/space-agent-schema';

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

describe('SpaceAgentManager', () => {
  let db: Database;
  let repo: SpaceAgentRepository;
  let longHorizonRepo: SpaceLongHorizonAgentRepository;
  let manager: SpaceAgentManager;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceAgentSchema(db);
    insertSpace(db);
    repo = new SpaceAgentRepository(db as any);
    longHorizonRepo = new SpaceLongHorizonAgentRepository(db as any);
    manager = new SpaceAgentManager(repo, longHorizonRepo);
    setModelsCache(new Map());
  });

  afterEach(() => {
    db.close();
    setModelsCache(new Map());
  });

  describe('create', () => {
    it('creates an agent with minimal params', async () => {
      const result = await manager.create({ spaceId: 'space-1', name: 'Coder' });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.name).toBe('Coder');
      expect(result.value.handle).toBe('coder');
    });

    it('rejects duplicate explicit handles within same space', async () => {
      await manager.create({ spaceId: 'space-1', name: 'Coder', handle: 'worker' });
      const dup = await manager.create({ spaceId: 'space-1', name: 'Reviewer', handle: 'worker' });
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.error).toContain('handle "worker"');
    });

    it('rejects reserved explicit handles', async () => {
      const result = await manager.create({
        spaceId: 'space-1',
        name: 'Coordinator',
        handle: 'coordinator',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('reserved');
    });

    it('auto-generates collision handles within the slug length limit', async () => {
      const name = 'A'.repeat(60);
      const first = await manager.create({ spaceId: 'space-1', name });
      const second = await manager.create({ spaceId: 'space-1', name: `${name} 2` });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('expected ok');
      expect(second.value.handle.length).toBeLessThanOrEqual(60);
      expect(second.value.handle.endsWith('-2')).toBe(true);
    });

    it('auto-generates handles around long-horizon agent collisions', async () => {
      longHorizonRepo.create({
        spaceId: 'space-1',
        handle: 'scout',
        displayName: 'Scout',
      });

      const result = await manager.create({ spaceId: 'space-1', name: 'Scout' });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.handle).toBe('scout-2');
    });

    it('rejects explicit handles used by long-horizon agents', async () => {
      longHorizonRepo.create({
        spaceId: 'space-1',
        handle: 'scout',
        displayName: 'Scout',
      });

      const result = await manager.create({
        spaceId: 'space-1',
        name: 'Worker Scout',
        handle: 'scout',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('handle "scout"');
    });

    it('creates agents with all valid roles', async () => {
      const roles = ['planner', 'coder', 'general'] as const;
      for (const role of roles) {
        const result = await manager.create({
          spaceId: 'space-1',
          name: `Agent-${role}`,
          role,
        });
        expect(result.ok).toBe(true);
      }
    });

    it('rejects duplicate name (case-insensitive) within same space', async () => {
      await manager.create({ spaceId: 'space-1', name: 'Coder' });
      const dup = await manager.create({ spaceId: 'space-1', name: 'coder' });
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.error).toMatch(/already exists/i);
    });

    it('allows same name in different spaces', async () => {
      insertSpace(db, 'space-2');
      await manager.create({ spaceId: 'space-1', name: 'Coder' });
      const result = await manager.create({ spaceId: 'space-2', name: 'Coder' });
      expect(result.ok).toBe(true);
    });

    it('skips model validation when models cache is empty', async () => {
      const result = await manager.create({
        spaceId: 'space-1',
        name: 'Agent',
        model: 'some-future-model',
      });
      expect(result.ok).toBe(true);
    });

    it('validates model when models cache is populated (no provider)', async () => {
      const cache = new Map([['global', [makeModelInfo('claude-sonnet-4-6', 'sonnet')]]]);
      setModelsCache(cache);

      const bad = await manager.create({
        spaceId: 'space-1',
        name: 'Agent',
        model: 'gpt-4',
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toMatch(/Unrecognized model/);

      const good = await manager.create({
        spaceId: 'space-1',
        name: 'Agent2',
        model: 'sonnet',
      });
      expect(good.ok).toBe(true);
    });

    it('accepts legacy full model IDs via unfiltered path (no provider)', async () => {
      const cache = new Map([['global', [makeModelInfo('sonnet', 'sonnet')]]]);
      setModelsCache(cache);

      const result = await manager.create({
        spaceId: 'space-1',
        name: 'Agent',
        model: 'claude-3-5-sonnet-20241022',
      });
      expect(result.ok).toBe(true);
    });

    it('uses provider-aware validation when provider is supplied', async () => {
      const cache = new Map([
        [
          'global',
          [
            makeModelInfo('claude-sonnet-4-6', 'sonnet', 'anthropic'),
            makeModelInfo('glm-4-flash', 'glm-4-flash', 'glm'),
          ],
        ],
      ]);
      setModelsCache(cache);

      const bad = await manager.create({
        spaceId: 'space-1',
        name: 'Agent',
        model: 'glm-4-flash',
        provider: 'anthropic',
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toMatch(/anthropic/);

      const good = await manager.create({
        spaceId: 'space-1',
        name: 'Agent2',
        model: 'glm-4-flash',
        provider: 'glm',
      });
      expect(good.ok).toBe(true);
    });
  });

  describe('update', () => {
    it('updates fields', async () => {
      const created = await manager.create({ spaceId: 'space-1', name: 'Agent' });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.update(created.value.id, {
        name: 'Renamed',
        description: 'New desc',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Renamed');
        expect(result.value.description).toBe('New desc');
      }
    });

    it('allows keeping the same name on update', async () => {
      const created = await manager.create({ spaceId: 'space-1', name: 'Agent' });
      if (!created.ok) throw new Error('create failed');
      const result = await manager.update(created.value.id, { name: 'Agent' });
      expect(result.ok).toBe(true);
    });

    it('rejects renaming to an existing name', async () => {
      await manager.create({ spaceId: 'space-1', name: 'Agent A' });
      const b = await manager.create({ spaceId: 'space-1', name: 'Agent B' });
      if (!b.ok) throw new Error('create failed');

      const result = await manager.update(b.value.id, { name: 'Agent A' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/already exists/i);
    });

    it('accepts model: null (clearing model) without validation error', async () => {
      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Agent',
        model: 'opus',
        provider: 'anthropic',
      });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.update(created.value.id, { model: null });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.model).toBeUndefined();
    });

    it('uses existing agent provider for model validation when provider not in update params', async () => {
      const cache = new Map([
        ['global', [makeModelInfo('claude-sonnet-4-6', 'sonnet', 'anthropic')]],
      ]);
      setModelsCache(cache);

      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Agent',
        model: 'sonnet',
        provider: 'anthropic',
      });
      if (!created.ok) throw new Error('create failed');

      const bad = await manager.update(created.value.id, { model: 'gpt-4' });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toMatch(/anthropic/);
    });

    it('rejects handles used by long-horizon agents on update', async () => {
      longHorizonRepo.create({
        spaceId: 'space-1',
        handle: 'scout',
        displayName: 'Scout',
      });
      const created = await manager.create({ spaceId: 'space-1', name: 'Worker' });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.update(created.value.id, { handle: 'scout' });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('handle "scout"');
    });

    it('allows shared-ID agents to keep their own long-horizon handle on update', async () => {
      const created = await manager.create({ spaceId: 'space-1', name: 'Worker' });
      if (!created.ok) throw new Error('create failed');
      db.prepare(`DELETE FROM space_long_horizon_agents WHERE id = ?`).run(created.value.id);
      longHorizonRepo.create({
        id: created.value.id,
        spaceId: 'space-1',
        handle: 'shared-handle',
        displayName: 'Shared Agent',
      });

      const result = await manager.update(created.value.id, { handle: 'shared-handle' });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.handle).toBe('shared-handle');
    });

    it('returns error for unknown agent id', async () => {
      const result = await manager.update('no-such-id', { name: 'X' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/not found/i);
    });
  });

  describe('delete', () => {
    it('deletes an unreferenced agent', async () => {
      const created = await manager.create({ spaceId: 'space-1', name: 'Agent' });
      if (!created.ok) throw new Error('create failed');

      const result = manager.delete(created.value.id);
      expect(result.ok).toBe(true);
      expect(manager.getById(created.value.id)).toBeNull();
    });

    it('blocks deletion when agent is referenced by workflow nodes', async () => {
      const created = await manager.create({ spaceId: 'space-1', name: 'Agent' });
      if (!created.ok) throw new Error('create failed');

      insertWorkflow(db, 'wf-1', 'space-1', 'Release Workflow');
      insertWorkflowNode(db, 'node-1', 'wf-1', created.value.id);

      const result = manager.delete(created.value.id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/referenced/i);
        expect(result.details).toBeDefined();
        expect(result.details?.some((d) => d.includes('Release Workflow'))).toBe(true);
      }
    });

    it('returns error for unknown agent id', () => {
      const result = manager.delete('no-such-id');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/not found/i);
    });
  });

  describe('listBySpaceId', () => {
    it('returns all agents for a space', async () => {
      await manager.create({ spaceId: 'space-1', name: 'A' });
      await manager.create({ spaceId: 'space-1', name: 'B' });
      const agents = manager.listBySpaceId('space-1');
      expect(agents).toHaveLength(2);
    });
  });

  describe('getAgentsByIds', () => {
    it('returns only requested agents', async () => {
      const a = await manager.create({ spaceId: 'space-1', name: 'A' });
      await manager.create({ spaceId: 'space-1', name: 'B' });
      if (!a.ok) throw new Error('create failed');

      const result = manager.getAgentsByIds([a.value.id]);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('A');
    });
  });

  describe('create — tools validation', () => {
    it('accepts valid tool names from KNOWN_TOOLS', async () => {
      const result = await manager.create({
        spaceId: 'space-1',
        name: 'ToolAgent',
        tools: ['Read', 'Write', 'Bash', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList'],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tools).toEqual([
          'Read',
          'Write',
          'Bash',
          'TaskCreate',
          'TaskGet',
          'TaskUpdate',
          'TaskList',
        ]);
      }
    });

    it('rejects unknown tool names', async () => {
      const result = await manager.create({
        spaceId: 'space-1',
        name: 'BadTool',
        tools: ['Read', 'FakeTool'],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('"FakeTool"');
        expect(result.error).toContain('Unknown tool');
      }
    });

    it('rejects multiple unknown tool names in a single error', async () => {
      const result = await manager.create({
        spaceId: 'space-1',
        name: 'MultiBad',
        tools: ['NotATool', 'AlsoNotATool'],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('"NotATool"');
        expect(result.error).toContain('"AlsoNotATool"');
      }
    });

    it('accepts undefined tools (defaults to empty permissive profile)', async () => {
      const result = await manager.create({
        spaceId: 'space-1',
        name: 'NoTools',
        tools: undefined,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.tools).toEqual([]);
    });
  });

  describe('update — tools validation', () => {
    it('accepts valid tool names on update', async () => {
      const created = await manager.create({ spaceId: 'space-1', name: 'Agent' });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.update(created.value.id, { tools: ['Bash', 'Glob'] });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.tools).toEqual(['Bash', 'Glob']);
    });

    it('rejects invalid tool names on update', async () => {
      const created = await manager.create({ spaceId: 'space-1', name: 'Agent2' });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.update(created.value.id, { tools: ['InvalidTool'] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('"InvalidTool"');
    });

    it('accepts null tools (clearing the override to empty permissive profile)', async () => {
      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Agent3',
        tools: ['Read'],
      });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.update(created.value.id, { tools: null });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.tools).toEqual([]);
    });
  });
});
