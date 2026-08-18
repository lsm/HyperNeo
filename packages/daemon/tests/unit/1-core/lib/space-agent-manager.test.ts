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

  describe('getAgentDriftReport', () => {
    it('returns an empty report when the space has no agents', () => {
      const report = manager.getAgentDriftReport('space-1');
      expect(report.spaceId).toBe('space-1');
      expect(report.agents).toEqual([]);
    });

    it('omits user-created agents (no templateName) entirely from the report', async () => {
      await manager.create({ spaceId: 'space-1', name: 'CustomBot' });
      const report = manager.getAgentDriftReport('space-1');
      expect(report.agents).toEqual([]);
    });

    it('reports a pristine row as neither updateAvailable nor customized', async () => {
      const { getPresetAgentTemplates } = await import(
        '../../../../src/lib/space/agents/seed-agents'
      );
      const { computeAgentTemplateHash } = await import(
        '../../../../src/lib/space/agents/agent-template-hash'
      );
      const coder = getPresetAgentTemplates().find((p) => p.name === 'Coder');
      if (!coder) throw new Error('Coder preset missing');
      const hash = computeAgentTemplateHash(coder);

      await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: coder.description,
        tools: coder.tools,
        customPrompt: coder.customPrompt,
        templateName: 'Coder',
        templateHash: hash,
      });

      const report = manager.getAgentDriftReport('space-1');
      expect(report.agents).toHaveLength(1);
      expect(report.agents[0].agentName).toBe('Coder');
      expect(report.agents[0].templateName).toBe('Coder');
      expect(report.agents[0].updateAvailable).toBe(false);
      expect(report.agents[0].customized).toBe(false);
      expect(report.agents[0].rowHash).toBe(hash);
      expect(report.agents[0].storedHash).toBe(hash);
      expect(report.agents[0].currentHash).toBe(hash);
    });

    it('reports updateAvailable+customized when stored hash differs and the row was edited', async () => {
      await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: 'Old description',
        tools: ['Read'],
        customPrompt: 'old prompt',
        templateName: 'Coder',
        templateHash: 'stale-hash-value',
      });

      const report = manager.getAgentDriftReport('space-1');
      expect(report.agents).toHaveLength(1);
      expect(report.agents[0].updateAvailable).toBe(true);
      expect(report.agents[0].customized).toBe(true);
      expect(report.agents[0].storedHash).toBe('stale-hash-value');
      expect(report.agents[0].currentHash).not.toBe('stale-hash-value');
    });

    it('reports legacy coordinator Reviewer prompt rows as update-available without mutating them', async () => {
      const { getPresetAgentTemplates, LEGACY_REVIEWER_PROMPT } = await import(
        '../../../../src/lib/space/agents/seed-agents'
      );
      const { computeAgentTemplateHash } = await import(
        '../../../../src/lib/space/agents/agent-template-hash'
      );
      const reviewer = getPresetAgentTemplates().find((p) => p.name === 'Reviewer');
      if (!reviewer) throw new Error('Reviewer preset missing');
      const legacyHash = computeAgentTemplateHash({
        ...reviewer,
        customPrompt: LEGACY_REVIEWER_PROMPT,
      });

      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Reviewer',
        description: reviewer.description,
        tools: reviewer.tools,
        customPrompt: LEGACY_REVIEWER_PROMPT,
        templateName: 'Reviewer',
        templateHash: legacyHash,
      });
      if (!created.ok) throw new Error('create failed');

      const report = manager.getAgentDriftReport('space-1');
      expect(report.agents).toHaveLength(1);
      expect(report.agents[0].updateAvailable).toBe(true);
      expect(report.agents[0].customized).toBe(false);
      expect(report.agents[0].storedHash).toBe(legacyHash);
      expect(report.agents[0].currentHash).not.toBe(legacyHash);
      expect(manager.getById(created.value.id)?.customPrompt).toBe(LEGACY_REVIEWER_PROMPT);
    });

    it('reports user-edited legacy Reviewer prompts as update-available', async () => {
      const { getPresetAgentTemplates, LEGACY_REVIEWER_PROMPT } = await import(
        '../../../../src/lib/space/agents/seed-agents'
      );
      const { computeAgentTemplateHash } = await import(
        '../../../../src/lib/space/agents/agent-template-hash'
      );
      const reviewer = getPresetAgentTemplates().find((p) => p.name === 'Reviewer');
      if (!reviewer) throw new Error('Reviewer preset missing');
      const editedPrompt = `${LEGACY_REVIEWER_PROMPT}\n\nUser customization`;
      const editedLegacyHash = computeAgentTemplateHash({
        ...reviewer,
        customPrompt: editedPrompt,
      });

      await manager.create({
        spaceId: 'space-1',
        name: 'Reviewer',
        description: reviewer.description,
        tools: reviewer.tools,
        customPrompt: editedPrompt,
        templateName: 'Reviewer',
        templateHash: editedLegacyHash,
      });

      const report = manager.getAgentDriftReport('space-1');
      expect(report.agents).toHaveLength(1);
      expect(report.agents[0].updateAvailable).toBe(true);
      expect(report.agents[0].customized).toBe(false);
    });

    it('reports updateAvailable+customized when storedHash is null (post-backfill unmatchable rows)', async () => {
      await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        templateName: 'Coder',
      });

      const report = manager.getAgentDriftReport('space-1');
      expect(report.agents).toHaveLength(1);
      expect(report.agents[0].storedHash).toBeNull();
      expect(report.agents[0].updateAvailable).toBe(true);
      expect(report.agents[0].customized).toBe(true);
    });

    it('skips rows whose templateName no longer matches any preset', async () => {
      await manager.create({
        spaceId: 'space-1',
        name: 'Ghost',
        templateName: 'NonExistentPreset',
        templateHash: 'whatever',
      });

      const report = manager.getAgentDriftReport('space-1');
      expect(report.agents).toEqual([]);
    });

    it('derives all four states from the three hashes (customized-only + update-available-only)', async () => {
      const { getPresetAgentTemplates } = await import(
        '../../../../src/lib/space/agents/seed-agents'
      );
      const { computeAgentTemplateHash } = await import(
        '../../../../src/lib/space/agents/agent-template-hash'
      );
      const coder = getPresetAgentTemplates().find((p) => p.name === 'Coder');
      if (!coder) throw new Error('Coder preset missing');
      const currentHash = computeAgentTemplateHash(coder);
      const oldVersion = { ...coder, customPrompt: 'old prompt' };
      const oldHash = computeAgentTemplateHash(oldVersion);

      insertSpace(db, 'space-update-only');
      await manager.create({
        spaceId: 'space-update-only',
        name: 'Coder',
        description: oldVersion.description,
        tools: oldVersion.tools,
        customPrompt: oldVersion.customPrompt,
        templateName: 'Coder',
        templateHash: oldHash,
      });
      const updateOnly = manager.getAgentDriftReport('space-update-only').agents[0];
      expect(updateOnly.updateAvailable).toBe(true);
      expect(updateOnly.customized).toBe(false);
      expect(updateOnly.rowHash).toBe(oldHash);

      insertSpace(db, 'space-custom-only');
      await manager.create({
        spaceId: 'space-custom-only',
        name: 'Coder',
        description: coder.description,
        tools: coder.tools,
        customPrompt: 'user edit',
        templateName: 'Coder',
        templateHash: currentHash,
      });
      const customOnly = manager.getAgentDriftReport('space-custom-only').agents[0];
      expect(customOnly.updateAvailable).toBe(false);
      expect(customOnly.customized).toBe(true);
      expect(customOnly.rowHash).not.toBe(currentHash);
    });

    it('includes a matching orphaned preset-named agent as a one-click re-attach', async () => {
      const { getPresetAgentTemplates } = await import(
        '../../../../src/lib/space/agents/seed-agents'
      );
      const coder = getPresetAgentTemplates().find((p) => p.name === 'Coder');
      if (!coder) throw new Error('Coder preset missing');

      await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: coder.description,
        tools: coder.tools,
        customPrompt: coder.customPrompt,
      });

      const report = manager.getAgentDriftReport('space-1');
      expect(report.agents).toHaveLength(1);
      const entry = report.agents[0];
      expect(entry.orphaned).toBe(true);
      expect(entry.templateName).toBe('Coder');
      expect(entry.storedHash).toBeNull();
      expect(entry.updateAvailable).toBe(true);
      expect(entry.customized).toBe(false);
    });

    it('flags a divergent orphaned preset-named agent as customized (forces diff review)', async () => {
      await manager.create({
        spaceId: 'space-1',
        name: 'Reviewer',
        description: 'stale description',
        tools: ['Read'],
        customPrompt: 'stale NeoKai-era prompt',
      });

      const report = manager.getAgentDriftReport('space-1');
      expect(report.agents).toHaveLength(1);
      expect(report.agents[0].orphaned).toBe(true);
      expect(report.agents[0].updateAvailable).toBe(true);
      expect(report.agents[0].customized).toBe(true);
    });

    it('still omits a genuinely user-created agent (non-preset name, no templateName)', async () => {
      await manager.create({ spaceId: 'space-1', name: 'CustomBot' });
      const report = manager.getAgentDriftReport('space-1');
      expect(report.agents).toEqual([]);
    });
  });

  describe('syncFromTemplate', () => {
    it('rejects user-created (non-preset) agents', async () => {
      const created = await manager.create({ spaceId: 'space-1', name: 'CustomBot' });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.syncFromTemplate(created.value.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/not linked to a preset/i);
    });

    it('rejects when the agent ID does not exist', async () => {
      const result = await manager.syncFromTemplate('does-not-exist');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/not found/i);
    });

    it('rejects when the templateName references a preset that no longer exists', async () => {
      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Ghost',
        templateName: 'NonExistentPreset',
        templateHash: 'whatever',
      });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.syncFromTemplate(created.value.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/not found/i);
    });

    it('overwrites description, tools, and customPrompt with current preset values', async () => {
      const { getPresetAgentTemplates } = await import(
        '../../../../src/lib/space/agents/seed-agents'
      );
      const { computeAgentTemplateHash } = await import(
        '../../../../src/lib/space/agents/agent-template-hash'
      );
      const coder = getPresetAgentTemplates().find((p) => p.name === 'Coder');
      if (!coder) throw new Error('Coder preset missing');

      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: 'User-edited description',
        tools: ['Read'],
        customPrompt: 'User-edited prompt',
        templateName: 'Coder',
        templateHash: 'stale-hash',
      });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.syncFromTemplate(created.value.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');

      expect(result.value.description).toBe(coder.description);
      expect(result.value.tools).toEqual(coder.tools);
      expect(result.value.customPrompt).toBe(coder.customPrompt);
      expect(result.value.templateHash).toBe(computeAgentTemplateHash(coder));
    });

    it('preserves id, spaceId, name, model, and provider', async () => {
      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: 'old',
        tools: ['Read'],
        customPrompt: 'old',
        templateName: 'Coder',
        templateHash: 'stale',
      });
      if (!created.ok) throw new Error('create failed');

      const updated = await manager.update(created.value.id, {
        model: 'sonnet',
        provider: 'anthropic',
      });
      if (!updated.ok) throw new Error('update failed');

      const result = await manager.syncFromTemplate(created.value.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');

      expect(result.value.id).toBe(created.value.id);
      expect(result.value.spaceId).toBe(created.value.spaceId);
      expect(result.value.name).toBe('Coder');
      expect(result.value.model).toBe('sonnet');
      expect(result.value.provider).toBe('anthropic');
    });

    it('re-stamps templateHash so a follow-up drift report shows updateAvailable=false', async () => {
      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: 'old',
        tools: ['Read'],
        customPrompt: 'old',
        templateName: 'Coder',
        templateHash: 'stale-hash',
      });
      if (!created.ok) throw new Error('create failed');

      const before = manager.getAgentDriftReport('space-1');
      expect(before.agents[0].updateAvailable).toBe(true);

      const sync = await manager.syncFromTemplate(created.value.id);
      expect(sync.ok).toBe(true);

      const after = manager.getAgentDriftReport('space-1');
      expect(after.agents[0].updateAvailable).toBe(false);
      expect(after.agents[0].customized).toBe(false);
      expect(after.agents[0].storedHash).toBe(after.agents[0].currentHash);
    });

    it('accepts sync when expectedRowHash matches the current row', async () => {
      const { computeAgentTemplateHash } = await import(
        '../../../../src/lib/space/agents/agent-template-hash'
      );
      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: 'old',
        tools: ['Read'],
        customPrompt: 'old',
        templateName: 'Coder',
        templateHash: 'stale-hash',
      });
      if (!created.ok) throw new Error('create failed');

      const reviewedRowHash = computeAgentTemplateHash({
        name: 'Coder',
        description: 'old',
        tools: ['Read'],
        customPrompt: 'old',
      });

      const result = await manager.syncFromTemplate(created.value.id, reviewedRowHash);
      expect(result.ok).toBe(true);
    });

    it('rejects sync when expectedRowHash no longer matches (concurrent edit)', async () => {
      const { computeAgentTemplateHash } = await import(
        '../../../../src/lib/space/agents/agent-template-hash'
      );
      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: 'old',
        tools: ['Read'],
        customPrompt: 'old',
        templateName: 'Coder',
        templateHash: 'stale-hash',
      });
      if (!created.ok) throw new Error('create failed');

      const reviewedRowHash = computeAgentTemplateHash({
        name: 'Coder',
        description: 'old',
        tools: ['Read'],
        customPrompt: 'old',
      });

      await manager.update(created.value.id, { customPrompt: 'concurrent edit by another client' });

      const result = await manager.syncFromTemplate(created.value.id, reviewedRowHash);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/changed since/i);
      expect(manager.getById(created.value.id)?.customPrompt).toBe(
        'concurrent edit by another client'
      );
    });

    it('re-attaches an orphaned preset-named agent by name and re-stamps tracking', async () => {
      const { getPresetAgentTemplates } = await import(
        '../../../../src/lib/space/agents/seed-agents'
      );
      const { computeAgentTemplateHash } = await import(
        '../../../../src/lib/space/agents/agent-template-hash'
      );
      const coder = getPresetAgentTemplates().find((p) => p.name === 'Coder');
      if (!coder) throw new Error('Coder preset missing');

      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: 'stale description',
        tools: ['Read'],
        customPrompt: 'stale prompt',
      });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.syncFromTemplate(created.value.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');

      expect(result.value.description).toBe(coder.description);
      expect(result.value.tools).toEqual(coder.tools);
      expect(result.value.customPrompt).toBe(coder.customPrompt);
      expect(result.value.templateName).toBe('Coder');
      expect(result.value.templateHash).toBe(computeAgentTemplateHash(coder));

      const report = manager.getAgentDriftReport('space-1');
      expect(report.agents[0].orphaned).toBe(false);
      expect(report.agents[0].updateAvailable).toBe(false);
    });
  });

  describe('getTemplateSyncPreview', () => {
    it('rejects user-created (non-preset) agents', async () => {
      const created = await manager.create({ spaceId: 'space-1', name: 'CustomBot' });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.getTemplateSyncPreview(created.value.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/not linked to a preset/i);
    });

    it('rejects when the agent ID does not exist', async () => {
      const result = await manager.getTemplateSyncPreview('does-not-exist');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/not found/i);
    });

    it('rejects when the templateName references a preset that no longer exists', async () => {
      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Ghost',
        templateName: 'NonExistentPreset',
        templateHash: 'whatever',
      });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.getTemplateSyncPreview(created.value.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/not found/i);
    });

    it('returns a before/after diff for drifted fields without writing', async () => {
      const { getPresetAgentTemplates } = await import(
        '../../../../src/lib/space/agents/seed-agents'
      );
      const coder = getPresetAgentTemplates().find((p) => p.name === 'Coder');
      if (!coder) throw new Error('Coder preset missing');

      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: 'User-edited description',
        tools: ['Read', 'Bash'],
        customPrompt: 'User-edited prompt',
        templateName: 'Coder',
        templateHash: 'stale-hash',
      });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.getTemplateSyncPreview(created.value.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');

      const preview = result.value;
      expect(preview.agentId).toBe(created.value.id);
      expect(preview.agentName).toBe('Coder');
      expect(preview.templateName).toBe('Coder');
      expect(preview.updateAvailable).toBe(true);
      expect(preview.customized).toBe(true);
      expect(preview.storedHash).toBe('stale-hash');
      expect(preview.liveHash).not.toBe('stale-hash');

      expect(preview.diff.customPrompt).toEqual({
        before: 'User-edited prompt',
        after: coder.customPrompt,
      });
      expect(preview.diff.description).toEqual({
        before: 'User-edited description',
        after: coder.description,
      });
      expect(preview.diff.tools?.added).toEqual([]);
      expect(preview.diff.tools?.removed).toEqual(['Read', 'Bash']);

      const row = manager.getById(created.value.id);
      expect(row?.customPrompt).toBe('User-edited prompt');
      expect(row?.templateHash).toBe('stale-hash');
    });

    it('reports drifted=false with an empty diff when the row matches the preset', async () => {
      const { getPresetAgentTemplates } = await import(
        '../../../../src/lib/space/agents/seed-agents'
      );
      const { computeAgentTemplateHash } = await import(
        '../../../../src/lib/space/agents/agent-template-hash'
      );
      const coder = getPresetAgentTemplates().find((p) => p.name === 'Coder');
      if (!coder) throw new Error('Coder preset missing');

      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: coder.description,
        tools: coder.tools,
        customPrompt: coder.customPrompt,
        templateName: 'Coder',
        templateHash: computeAgentTemplateHash(coder),
      });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.getTemplateSyncPreview(created.value.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');

      expect(result.value.updateAvailable).toBe(false);
      expect(result.value.customized).toBe(false);
      expect(result.value.diff).toEqual({});
      expect(result.value.storedHash).toBe(result.value.liveHash);
    });

    it('reports updateAvailable=true with an empty diff when only the stored hash is missing', async () => {
      const { getPresetAgentTemplates } = await import(
        '../../../../src/lib/space/agents/seed-agents'
      );
      const coder = getPresetAgentTemplates().find((p) => p.name === 'Coder');
      if (!coder) throw new Error('Coder preset missing');

      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: coder.description,
        tools: coder.tools,
        customPrompt: coder.customPrompt,
        templateName: 'Coder',
      });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.getTemplateSyncPreview(created.value.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');

      expect(result.value.updateAvailable).toBe(true);
      expect(result.value.storedHash).toBeNull();
      expect(result.value.diff).toEqual({});
    });

    it('treats reordered tool lists as equal (no tools diff)', async () => {
      const { getPresetAgentTemplates } = await import(
        '../../../../src/lib/space/agents/seed-agents'
      );
      const reviewer = getPresetAgentTemplates().find((p) => p.name === 'Reviewer');
      if (!reviewer) throw new Error('Reviewer preset missing');

      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Reviewer',
        description: reviewer.description,
        tools: [...reviewer.tools].reverse(),
        customPrompt: reviewer.customPrompt,
        templateName: 'Reviewer',
        templateHash: 'stale',
      });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.getTemplateSyncPreview(created.value.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.diff.tools).toBeUndefined();
    });

    it('returns a diff for an orphaned preset-named agent and resolves the templateName', async () => {
      const { getPresetAgentTemplates } = await import(
        '../../../../src/lib/space/agents/seed-agents'
      );
      const coder = getPresetAgentTemplates().find((p) => p.name === 'Coder');
      if (!coder) throw new Error('Coder preset missing');

      const created = await manager.create({
        spaceId: 'space-1',
        name: 'Coder',
        description: 'stale description',
        tools: ['Read'],
        customPrompt: 'stale prompt',
      });
      if (!created.ok) throw new Error('create failed');

      const result = await manager.getTemplateSyncPreview(created.value.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');

      const preview = result.value;
      expect(preview.templateName).toBe('Coder');
      expect(preview.diff.customPrompt).toEqual({
        before: 'stale prompt',
        after: coder.customPrompt,
      });
      expect(manager.getById(created.value.id)?.templateName).toBeFalsy();
    });

    it('mirrors the drift report orphaned `customized` semantics', async () => {
      const { getPresetAgentTemplates } = await import(
        '../../../../src/lib/space/agents/seed-agents'
      );
      const coder = getPresetAgentTemplates().find((p) => p.name === 'Coder');
      if (!coder) throw new Error('Coder preset missing');

      insertSpace(db, 'space-divergent');
      const divergent = await manager.create({
        spaceId: 'space-divergent',
        name: 'Coder',
        description: 'user edit',
        customPrompt: 'user-edited prompt',
      });
      if (!divergent.ok) throw new Error('create failed');
      const divergentPreview = await manager.getTemplateSyncPreview(divergent.value.id);
      if (!divergentPreview.ok) throw new Error('expected ok');
      expect(divergentPreview.value.customized).toBe(true);

      insertSpace(db, 'space-matching');
      const matching = await manager.create({
        spaceId: 'space-matching',
        name: 'Coder',
        description: coder.description,
        tools: coder.tools,
        customPrompt: coder.customPrompt,
      });
      if (!matching.ok) throw new Error('create failed');
      const matchingPreview = await manager.getTemplateSyncPreview(matching.value.id);
      if (!matchingPreview.ok) throw new Error('expected ok');
      expect(matchingPreview.value.customized).toBe(false);
    });
  });
});
