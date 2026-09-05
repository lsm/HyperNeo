import { describe, expect, test } from 'bun:test';
import type { SpaceLongHorizonAgent, WorkflowNodeAgent } from '@hyperneo/shared';
import type { NodeAgentSpawnConfig } from '../../../../src/lib/space/runtime/spawn-slot-resolution.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { SpaceAgentTemplateRepository } from '../../../../src/storage/repositories/space-agent-template-repository.ts';
import { runMigration226 } from '../../../../src/storage/schema/m226-space-agent-templates-version';
import { runMigration227 } from '../../../../src/storage/schema/m227-space-agent-template-version-seq';
import { createSpaceAgentTemplatesTable } from '../../../../src/storage/schema/space-agent-templates';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

describe('TaskAgentManager slot spawn resolution (stored templates + agentId fallback)', () => {
  function makeTemplateDb(): BunDatabase {
    const db = new BunDatabase(':memory:');
    createSpaceAgentTemplatesTable(db);
    runMigration226(db);
    runMigration227(db);
    return db;
  }

  function makeManager(db: BunDatabase, unifiedAgent?: SpaceLongHorizonAgent): TaskAgentManager {
    return new TaskAgentManager({
      db: { getDatabase: () => db },
      internalEventBus: { subscribe: () => () => {} },
      longHorizonAgentRepo: unifiedAgent
        ? { getById: (id: string) => (id === unifiedAgent.id ? unifiedAgent : null) }
        : undefined,
    } as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);
  }

  function resolveSlot(
    manager: TaskAgentManager,
    spaceId: string,
    slot: WorkflowNodeAgent
  ): NodeAgentSpawnConfig | null {
    const internals = manager as unknown as {
      resolveSlotSpawnConfig: (
        spaceId: string,
        slot: WorkflowNodeAgent
      ) => NodeAgentSpawnConfig | null;
    };
    return internals.resolveSlotSpawnConfig(spaceId, slot);
  }

  function activeUnifiedAgent(): SpaceLongHorizonAgent {
    return {
      id: 'agent-1',
      spaceId: 'space-1',
      handle: 'registry-agent',
      displayName: 'Registry Agent',
      templateKey: null,
      status: 'active',
      sessionId: null,
      instructions: 'Registry base contract',
      autonomyLevel: null,
      model: 'agent-model',
      thinkingLevel: null,
      provider: null,
      settingSources: null,
      toolPermissions: {},
      createdAt: 100,
      updatedAt: 200,
    };
  }

  test('resolves a stored template key through the template branch', () => {
    const db = makeTemplateDb();
    new SpaceAgentTemplateRepository(db).create({
      key: 'migrated.coder',
      handle: 'coder',
      displayName: 'Coder',
      instructions: 'Template base contract',
      model: 'claude-x',
      tools: ['Read'],
    });
    const manager = makeManager(db);

    const config = resolveSlot(manager, 'space-1', {
      agentId: 'agent-1',
      templateKey: 'migrated.coder',
      name: 'coder',
    });

    expect(config?.source).toBe('template');
    expect(config?.templateKey).toBe('migrated.coder');
    expect(config?.agent.id).toBe('template:migrated.coder');
    expect(config?.agent.customPrompt).toBe('Template base contract');
    expect(config?.agent.model).toBe('claude-x');
    expect(config?.agent.tools).toEqual(['Read']);
    db.close();
  });

  test('resolves a built-in template key and prefers it over a stored key of the same name', () => {
    const db = makeTemplateDb();
    new SpaceAgentTemplateRepository(db).create({
      key: 'research.default',
      handle: 'research-shadow',
      displayName: 'Shadow',
      instructions: 'Stored shadow',
    });
    const manager = makeManager(db);

    const config = resolveSlot(manager, 'space-1', {
      agentId: '',
      templateKey: 'research.default',
      name: 'researcher',
    });

    expect(config?.source).toBe('template');
    expect(config?.agent.id).toBe('template:research.default');
    expect(config?.agent.handle).not.toBe('research-shadow');
    db.close();
  });

  test('falls back to the kept agentId when the template key resolves nowhere', () => {
    const db = makeTemplateDb();
    const manager = makeManager(db, activeUnifiedAgent());

    const config = resolveSlot(manager, 'space-1', {
      agentId: 'agent-1',
      templateKey: 'deleted.template',
      name: 'coder',
    });

    expect(config?.source).toBe('agent');
    expect(config?.agent.id).toBe('agent-1');
    expect(config?.agent.customPrompt).toBe('Registry base contract');
    expect(config?.agent.model).toBe('agent-model');
    db.close();
  });

  test('returns null for an unresolvable template key on a template-only slot', () => {
    const db = makeTemplateDb();
    const manager = makeManager(db, activeUnifiedAgent());

    expect(
      resolveSlot(manager, 'space-1', {
        agentId: '',
        templateKey: 'deleted.template',
        name: 'coder',
      })
    ).toBeNull();
    db.close();
  });

  test('resolves a plain agentId slot through the registry agent', () => {
    const db = makeTemplateDb();
    const manager = makeManager(db, activeUnifiedAgent());

    const config = resolveSlot(manager, 'space-1', {
      agentId: 'agent-1',
      name: 'coder',
    });

    expect(config?.source).toBe('agent');
    expect(config?.agent.name).toBe('coder');
    db.close();
  });
});
