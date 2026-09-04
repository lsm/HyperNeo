import { beforeEach, describe, expect, test } from 'bun:test';
import type {
  CreateSpaceAgentTemplateParams,
  SpaceAgentTemplate,
  UpdateSpaceLongHorizonAgentParams,
} from '@hyperneo/shared';
import { setModelsCache } from '../../../../src/lib/model-service';
import { MIGRATED_WORKER_TEMPLATE_KEY } from '../../../../src/lib/space/agents/worker-long-horizon-mapper';
import {
  ReapplyTemplateAgentSource,
  SpaceAgentTemplateReapplyService,
  templateToAgentUpdateParams,
} from '../../../../src/lib/space/managers/space-agent-template-reapply-service';
import { SpaceAgentTemplateManager } from '../../../../src/lib/space/managers/space-agent-template-manager';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceAgentTemplateRepository } from '../../../../src/storage/repositories/space-agent-template-repository';
import { runMigration226 } from '../../../../src/storage/schema/m226-space-agent-templates-version';
import { runMigration227 } from '../../../../src/storage/schema/m227-space-agent-template-version-seq';
import { createSpaceAgentTemplatesTable } from '../../../../src/storage/schema/space-agent-templates';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

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

function fullTemplateParams(): CreateSpaceAgentTemplateParams {
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

describe('SpaceAgentTemplateReapplyService', () => {
  let db: BunDatabase;
  let agentRepo: SpaceLongHorizonAgentRepository;
  let templateRepo: SpaceAgentTemplateRepository;
  let templateManager: SpaceAgentTemplateManager;
  let service: SpaceAgentTemplateReapplyService;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceTables(db);
    createSpaceAgentTemplatesTable(db);
    runMigration226(db);
    runMigration227(db);
    db.prepare(
      `INSERT INTO spaces (
				id, slug, workspace_path, name, description, background_context, instructions,
				allowed_models, session_ids, status, paused, stopped, autonomy_level,
				max_concurrent_tasks, created_at, updated_at
			) VALUES (?, ?, ?, ?, '', '', '', '[]', '[]', 'active', 0, 0, 1, 1, ?, ?)`
    ).run('space-1', 'space-1', '/tmp/space-1', 'Space 1', 1, 1);
    agentRepo = new SpaceLongHorizonAgentRepository(db);
    templateRepo = new SpaceAgentTemplateRepository(db);
    templateManager = new SpaceAgentTemplateManager(templateRepo, () => BUILT_INS);
    service = new SpaceAgentTemplateReapplyService(agentRepo, templateManager);
    setModelsCache(new Map());
  });

  describe('reapplyTemplate', () => {
    test('copies every template field onto the agent and preserves instance-layer fields', () => {
      const template = templateRepo.create(fullTemplateParams());
      const agent = agentRepo.create({
        spaceId: 'space-1',
        handle: 'reviewer',
        displayName: 'Drifted Reviewer',
        templateKey: template.key,
        instructions: 'Stale drifted instructions.',
        autonomyLevel: 4,
        model: 'claude-haiku-4-5',
        thinkingLevel: 'off',
        provider: 'other-provider',
        settingSources: ['local'],
        toolPermissions: { tools: ['Bash'] },
        description: 'Keeps the description.',
        modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 1, weight: 1 }],
      });

      const result = service.reapplyTemplate(agent.id);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.instructions).toBe('Coordinate release checks.');
      expect(result.value.model).toBe('claude-opus-5');
      expect(result.value.provider).toBe('anthropic');
      expect(result.value.modelPool).toEqual([
        { model: 'claude-opus-5', provider: 'anthropic', maxConcurrent: 2, weight: 3 },
      ]);
      expect(result.value.thinkingLevel).toBe('think16k');
      expect(result.value.settingSources).toEqual(['user', 'project']);
      expect(result.value.toolPermissions).toEqual({ tools: ['Read', 'Grep', 'Glob'] });
      expect(result.value.autonomyLevel).toBe(4);
      expect(result.value.handle).toBe('reviewer');
      expect(result.value.displayName).toBe('Drifted Reviewer');
      expect(result.value.description).toBe('Keeps the description.');
      expect(result.value.templateKey).toBe('release-readiness.custom');
      expect(agentRepo.getById(agent.id)).toEqual(result.value);
    });

    test('clears agent fields the template leaves unset', () => {
      const template = templateRepo.create({ key: 'blank.custom', handle: 'blank' });
      const agent = agentRepo.create({
        spaceId: 'space-1',
        handle: 'drifted',
        templateKey: template.key,
        instructions: 'Leftover instructions.',
        model: 'claude-haiku-4-5',
        thinkingLevel: 'off',
        provider: 'other-provider',
        settingSources: ['local'],
        toolPermissions: { tools: ['Bash'] },
        modelPool: [{ model: 'claude-haiku-4-5', maxConcurrent: 1, weight: 1 }],
      });

      const result = service.reapplyTemplate(agent.id);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.instructions).toBe('');
      expect(result.value.model).toBeNull();
      expect(result.value.provider).toBeNull();
      expect(result.value.modelPool).toBeUndefined();
      expect(result.value.thinkingLevel).toBeNull();
      expect(result.value.settingSources).toBeNull();
      expect(result.value.toolPermissions).toEqual({});
    });

    test('resolves built-in templates by key', () => {
      const agent = agentRepo.create({
        spaceId: 'space-1',
        handle: 'builtin-user',
        templateKey: 'builtin.default',
        instructions: 'Drifted.',
      });

      const result = service.reapplyTemplate(agent.id);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.value.instructions).toBe('Built-in instructions.');
    });

    test('rejects an unknown agent id', () => {
      const result = service.reapplyTemplate('missing-agent');

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected error');
      expect(result.error).toBe('Agent not found: missing-agent');
    });

    test('honors the migrated-worker mirror lock without touching the agent', () => {
      const agent = agentRepo.create({
        spaceId: 'space-1',
        handle: 'mirror',
        templateKey: 'release-readiness.custom',
        instructions: 'Mirror instructions.',
      });
      db.prepare(`UPDATE space_long_horizon_agents SET template_key = ? WHERE id = ?`).run(
        MIGRATED_WORKER_TEMPLATE_KEY,
        agent.id
      );
      const calls: UpdateSpaceLongHorizonAgentParams[] = [];
      const recording: ReapplyTemplateAgentSource = {
        getById: (id) => agentRepo.getById(id),
        update: (id, params) => {
          calls.push(params);
          return agentRepo.update(id, params);
        },
      };
      const locked = new SpaceAgentTemplateReapplyService(recording, templateManager);

      const result = locked.reapplyTemplate(agent.id);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected error');
      expect(result.error).toContain('migrated worker mirror');
      expect(result.error).toContain(agent.id);
      expect(calls).toEqual([]);
      expect(agentRepo.getById(agent.id)?.instructions).toBe('Mirror instructions.');
    });

    test('rejects an agent without a template', () => {
      const agent = agentRepo.create({
        spaceId: 'space-1',
        handle: 'ad-hoc',
        instructions: 'Ad-hoc instructions.',
      });

      const result = service.reapplyTemplate(agent.id);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected error');
      expect(result.error).toBe(`Agent ${agent.id} has no template to re-apply`);
    });

    test('rejects an agent whose template key resolves to nothing', () => {
      templateRepo.create({ key: 'live.custom', handle: 'live' });
      const agent = agentRepo.create({
        spaceId: 'space-1',
        handle: 'ghost-user',
        templateKey: 'ghost.custom',
      });

      const result = service.reapplyTemplate(agent.id);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected error');
      expect(result.error).toBe('Template not found: ghost.custom');
    });

    test('surfaces a repository failure as an error result', () => {
      const template = templateRepo.create({ key: 'throwing.custom', handle: 'throwing' });
      const agent = agentRepo.create({
        spaceId: 'space-1',
        handle: 'racer',
        templateKey: template.key,
      });
      const throwing: ReapplyTemplateAgentSource = {
        getById: (id) => agentRepo.getById(id),
        update: () => {
          throw new Error('lock exploded');
        },
      };
      const racing = new SpaceAgentTemplateReapplyService(throwing, templateManager);

      const result = racing.reapplyTemplate(agent.id);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected error');
      expect(result.error).toBe('Failed to re-apply template: lock exploded');
    });

    test('reports an agent that vanishes during the update', () => {
      const template = templateRepo.create({ key: 'vanish.custom', handle: 'vanish' });
      const agent = agentRepo.create({
        spaceId: 'space-1',
        handle: 'vanisher',
        templateKey: template.key,
      });
      const vanishing: ReapplyTemplateAgentSource = {
        getById: (id) => agentRepo.getById(id),
        update: () => null,
      };
      const vanishingService = new SpaceAgentTemplateReapplyService(vanishing, templateManager);

      const result = vanishingService.reapplyTemplate(agent.id);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected error');
      expect(result.error).toBe(`Agent not found after re-apply: ${agent.id}`);
    });
  });

  describe('templateToAgentUpdateParams', () => {
    test('maps only template-owned fields', () => {
      const params = templateToAgentUpdateParams({
        ...BUILT_INS[0],
        instructions: 'Fresh instructions.',
        model: 'claude-opus-5',
        provider: 'anthropic',
        modelPool: [{ model: 'claude-opus-5', provider: 'anthropic', maxConcurrent: 1, weight: 1 }],
        thinkingLevel: 'think8k',
        settingSources: ['user'],
        tools: ['Read'],
      });

      expect(Object.keys(params).sort()).toEqual(
        [
          'instructions',
          'model',
          'modelPool',
          'provider',
          'settingSources',
          'thinkingLevel',
          'toolPermissions',
        ].sort()
      );
      expect(params.toolPermissions).toEqual({ tools: ['Read'] });
    });

    test('maps empty and missing tool lists to empty permissions', () => {
      expect(templateToAgentUpdateParams({ ...BUILT_INS[0], tools: [] }).toolPermissions).toEqual(
        {}
      );
      expect(templateToAgentUpdateParams({ ...BUILT_INS[0], tools: null }).toolPermissions).toEqual(
        {}
      );
    });
  });
});
