import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import { setModelsCache } from '../../../../src/lib/model-service';
import { setupSpaceAgentHandlers } from '../../../../src/lib/rpc-handlers/space-agent-handlers';
import { SpaceAgentTemplateManager } from '../../../../src/lib/space/managers/space-agent-template-manager';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { SpaceAgentTemplateRepository } from '../../../../src/storage/repositories/space-agent-template-repository';
import {
  SpaceLongHorizonAgentRepository,
  templateInstanceScanFromRepo,
} from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import { runMigration226 } from '../../../../src/storage/schema/m226-space-agent-templates-version';
import { runMigration227 } from '../../../../src/storage/schema/m227-space-agent-template-version-seq';
import { runMigration238 } from '../../../../src/storage/schema/m238-space-agent-template-labels';
import { runMigration243 } from '../../../../src/storage/schema/m243-space-agent-template-space-key';
import { runMigration246 } from '../../../../src/storage/schema/m246-template-version-seq-space-key';
import { createSpaceAgentTemplatesTable } from '../../../../src/storage/schema/space-agent-templates';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  createSpaceAgentSchema,
  insertSpace,
  insertWorkflow,
} from '../../helpers/space-agent-schema';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    onEvent: mock(() => () => {}),
    request: mock(async () => {}),
    event: mock(() => {}),
    joinChannel: mock(async () => {}),
    leaveChannel: mock(async () => {}),
    isConnected: mock(() => true),
    getState: mock(() => 'connected' as const),
    onConnection: mock(() => () => {}),
    onMessage: mock(() => () => {}),
    cleanup: mock(() => {}),
    registerTransport: mock(() => () => {}),
    registerRouter: mock(() => {}),
    getRouter: mock(() => null),
    getPendingCallCount: mock(() => 0),
  } as unknown as MessageHub;
  return { hub, handlers };
}

function createMockInternalEventBus(): {
  internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  publishMock: ReturnType<typeof mock>;
} {
  const publishMock = mock(async () => ({ delivered: 0, failures: [] }));
  const internalEventBus = {
    publish: publishMock,
    publishAsync: mock(() => {}),
    subscribe: mock(() => () => {}),
    off: mock(() => {}),
    clear: mock(() => {}),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
  return { internalEventBus, publishMock };
}

function createMockSpaceManager(): {
  spaceManager: SpaceManager;
  getSpaceMock: ReturnType<typeof mock>;
} {
  type GetSpaceResult = Awaited<ReturnType<SpaceManager['getSpace']>>;
  const getSpaceMock = mock(async (spaceId: string): Promise<GetSpaceResult> => {
    return spaceId === 'space-1' || spaceId === 'space-2'
      ? ({ id: spaceId } as unknown as Exclude<GetSpaceResult, null>)
      : null;
  });
  const spaceManager = {
    getSpace: getSpaceMock,
  } as unknown as SpaceManager;
  return { spaceManager, getSpaceMock };
}

async function call<T>(
  handlers: Map<string, RequestHandler>,
  method: string,
  params: unknown
): Promise<T> {
  const handler = handlers.get(method);
  if (!handler) throw new Error(`Handler not registered: ${method}`);
  return (await handler(params, {})) as T;
}

describe('Space Agent RPC Handlers', () => {
  let db: Database;
  let hubData: ReturnType<typeof createMockMessageHub>;
  let daemonData: ReturnType<typeof createMockInternalEventBus>;
  let spaceManagerData: ReturnType<typeof createMockSpaceManager>;
  let longHorizonRepo: SpaceLongHorizonAgentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceAgentSchema(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS space_workflow_definition_versions (
        workflow_id TEXT NOT NULL,
        version_hash TEXT NOT NULL,
        space_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, version_hash)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS space_workflow_runs (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        definition_version TEXT,
        title TEXT,
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS space_tasks (
        id TEXT PRIMARY KEY,
        workflow_run_id TEXT,
        archived_at INTEGER
      )
    `);
    createSpaceAgentTemplatesTable(db);
    runMigration226(db);
    runMigration227(db);
    runMigration238(db);
    runMigration243(db);
    runMigration246(db);
    insertSpace(db, 'space-1');

    longHorizonRepo = new SpaceLongHorizonAgentRepository(db as any);
    hubData = createMockMessageHub();
    daemonData = createMockInternalEventBus();
    spaceManagerData = createMockSpaceManager();

    setModelsCache(new Map());

    setupSpaceAgentHandlers(
      hubData.hub,
      daemonData.internalEventBus,
      spaceManagerData.spaceManager,
      longHorizonRepo,
      undefined,
      new SpaceAgentTemplateManager(
        new SpaceAgentTemplateRepository(db as any),
        undefined,
        templateInstanceScanFromRepo(longHorizonRepo)
      )
    );
  });

  afterEach(() => {
    db.close();
    setModelsCache(new Map());
    mock.restore();
  });

  describe('spaceAgent.listBuiltInTemplates', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.listBuiltInTemplates')).toBe(true);
    });

    it('returns unified long-horizon templates on the spaceAgent namespace', async () => {
      const result = await call<{
        templates: Array<{ key: string; displayName: string; instructions: string }>;
      }>(hubData.handlers, 'spaceAgent.listBuiltInTemplates', {
        spaceId: 'space-1',
      });

      expect(Array.isArray(result.templates)).toBe(true);
      expect(result.templates.length).toBeGreaterThan(0);
      for (const template of result.templates) {
        expect(template.displayName.length).toBeGreaterThan(0);
        expect(template.instructions.length).toBeGreaterThan(0);
      }
    });

    it('returns exactly the current 5 built-in templates (ATC-1/ATC-3/ATC-4 pin)', async () => {
      const result = await call<{ templates: Array<{ key: string; handle: string }> }>(
        hubData.handlers,
        'spaceAgent.listBuiltInTemplates',
        { spaceId: 'space-1' }
      );

      expect(result.templates).toHaveLength(5);
      expect(result.templates.map((template) => template.key)).toEqual([
        'task-manager.default',
        'worker.swe',
        'worker.research',
        'worker.reviewer',
        'worker.qa',
      ]);
      expect(result.templates.map((template) => template.handle)).toEqual([
        'task-manager',
        'swe',
        'research',
        'reviewer',
        'qa',
      ]);
    });

    it('returns labels on built-in templates (ATC-2)', async () => {
      const result = await call<{ templates: Array<{ key: string; labels?: string[] }> }>(
        hubData.handlers,
        'spaceAgent.listBuiltInTemplates',
        { spaceId: 'space-1' }
      );

      for (const template of result.templates) {
        expect(template.labels, template.key).toBeDefined();
        if (template.key.startsWith('worker.')) {
          expect(template.labels).toEqual(['workflow-worker']);
        } else {
          expect(template.labels).toEqual(['long-horizon']);
        }
      }
    });

    it('omits the reserved coordinator card (ATC-3)', async () => {
      const result = await call<{ templates: Array<{ key: string; handle: string }> }>(
        hubData.handlers,
        'spaceAgent.listBuiltInTemplates',
        { spaceId: 'space-1' }
      );

      expect(result.templates.map((template) => template.key)).not.toContain('coordinator.default');
      expect(result.templates.map((template) => template.handle)).not.toContain('coordinator');
    });

    it('throws when spaceId is missing', async () => {
      await expect(call(hubData.handlers, 'spaceAgent.listBuiltInTemplates', {})).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('throws when space does not exist', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.listBuiltInTemplates', { spaceId: 'missing-space' })
      ).rejects.toThrow('Space not found: missing-space');
    });
  });

  describe('spaceAgent.listTemplates', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceAgent.listTemplates')).toBe(true);
    });

    it('returns built-in templates in the unified template shape', async () => {
      const result = await call<{
        templates: Array<{
          key: string;
          displayName: string;
          model: string | null;
          createdAt: number;
        }>;
      }>(hubData.handlers, 'spaceAgent.listTemplates', { spaceId: 'space-1', spaceId: 'space-1' });

      expect(Array.isArray(result.templates)).toBe(true);
      expect(result.templates.map((template) => template.key)).toContain('worker.swe');
      expect(result.templates.map((template) => template.key)).not.toContain('coordinator.default');
      for (const template of result.templates) {
        expect(typeof template.createdAt).toBe('number');
        expect(template.model).toBe(null);
      }
    });

    it('merges custom templates with built-ins', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        spaceId: 'space-1',
        key: 'review.custom',
        handle: 'review',
        displayName: 'Review',
      });

      const result = await call<{ templates: Array<{ key: string }> }>(
        hubData.handlers,
        'spaceAgent.listTemplates',
        { spaceId: 'space-1', spaceId: 'space-1' }
      );

      const keys = result.templates.map((template) => template.key);
      expect(keys).toContain('review.custom');
      expect(keys).toContain('worker.swe');
      expect(keys).not.toContain('coordinator.default');
    });
  });

  describe('spaceAgent.createTemplate', () => {
    it('creates a custom template and returns it', async () => {
      const result = await call<{
        template: { key: string; handle: string; displayName: string };
      }>(hubData.handlers, 'spaceAgent.createTemplate', {
        spaceId: 'space-1',
        key: 'release.custom',
        handle: 'release',
        displayName: 'Release',
      });

      expect(result.template.key).toBe('release.custom');
      expect(result.template.handle).toBe('release');
      expect(result.template.displayName).toBe('Release');
    });

    it('throws when key is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.createTemplate', {
          spaceId: 'space-1',
          handle: 'release',
        })
      ).rejects.toThrow('key is required');
    });

    it('throws when handle is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.createTemplate', {
          spaceId: 'space-1',
          key: 'release.custom',
        })
      ).rejects.toThrow('handle is required');
    });

    it('surfaces manager validation errors for a duplicate key', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        spaceId: 'space-1',
        key: 'dup.custom',
        handle: 'dup',
      });

      await expect(
        call(hubData.handlers, 'spaceAgent.createTemplate', {
          spaceId: 'space-1',
          key: 'dup.custom',
          handle: 'dup',
        })
      ).rejects.toThrow('already exists');
    });
  });

  describe('spaceAgent.updateTemplate', () => {
    it('updates a custom template and returns it', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        spaceId: 'space-1',
        key: 'update.custom',
        handle: 'update',
        displayName: 'Before',
      });

      const result = await call<{ template: { displayName: string } | null }>(
        hubData.handlers,
        'spaceAgent.updateTemplate',
        { spaceId: 'space-1', key: 'update.custom', displayName: 'After' }
      );

      expect(result.template?.displayName).toBe('After');
    });

    it('throws when key is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.updateTemplate', {
          spaceId: 'space-1',
          displayName: 'X',
        })
      ).rejects.toThrow('key is required');
    });

    it('throws for an unknown key', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.updateTemplate', {
          spaceId: 'space-1',
          key: 'missing.custom',
          displayName: 'X',
        })
      ).rejects.toThrow('Template not found: missing.custom');
    });

    it('returns a null template when the client expected version is stale', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        spaceId: 'space-1',
        key: 'cas.custom',
        handle: 'cas',
        displayName: 'One',
      });
      const second = await call<{ template: { version?: number } | null }>(
        hubData.handlers,
        'spaceAgent.updateTemplate',
        { spaceId: 'space-1', key: 'cas.custom', displayName: 'Two' }
      );

      const stale = await call<{ template: { displayName: string } | null }>(
        hubData.handlers,
        'spaceAgent.updateTemplate',
        { spaceId: 'space-1', key: 'cas.custom', displayName: 'Stale', expectedVersion: 1 }
      );
      expect(stale.template).toBeNull();

      const fresh = await call<{ template: { displayName: string; version?: number } | null }>(
        hubData.handlers,
        'spaceAgent.updateTemplate',
        {
          spaceId: 'space-1',
          key: 'cas.custom',
          displayName: 'Three',
          expectedVersion: second.template?.version,
        }
      );
      expect(fresh.template?.displayName).toBe('Three');
    });
  });

  describe('spaceAgent template scoping', () => {
    it('throws when spaceId is missing', async () => {
      await expect(call(hubData.handlers, 'spaceAgent.listTemplates', {})).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('throws when the space does not exist', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.listTemplates', { spaceId: 'missing-space' })
      ).rejects.toThrow('Space not found: missing-space');
    });

    it('hides another space custom template from listTemplates', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        spaceId: 'space-1',
        key: 'scoped.custom',
        handle: 'scoped',
      });

      const result = await call<{ templates: Array<{ key: string }> }>(
        hubData.handlers,
        'spaceAgent.listTemplates',
        { spaceId: 'space-2' }
      );

      expect(result.templates.map((template) => template.key)).not.toContain('scoped.custom');
      expect(result.templates.map((template) => template.key)).toContain('worker.swe');
    });

    it('refuses to delete a template another space owns', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        spaceId: 'space-1',
        key: 'owned.custom',
        handle: 'owned',
      });

      await expect(
        call(hubData.handlers, 'spaceAgent.deleteTemplate', {
          spaceId: 'space-2',
          key: 'owned.custom',
        })
      ).rejects.toThrow('Template not found: owned.custom');

      const list = await call<{ templates: Array<{ key: string }> }>(
        hubData.handlers,
        'spaceAgent.listTemplates',
        { spaceId: 'space-1' }
      );
      expect(list.templates.map((template) => template.key)).toContain('owned.custom');
    });

    it('refuses to update a template another space owns', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        spaceId: 'space-1',
        key: 'guarded.custom',
        handle: 'guarded',
        displayName: 'Original',
      });

      await expect(
        call(hubData.handlers, 'spaceAgent.updateTemplate', {
          spaceId: 'space-2',
          key: 'guarded.custom',
          displayName: 'Hijacked',
        })
      ).rejects.toThrow('Template not found: guarded.custom');
    });
  });

  describe('spaceAgent.deleteTemplate', () => {
    it('deletes a custom template', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        spaceId: 'space-1',
        key: 'delete.custom',
        handle: 'delete',
      });

      const result = await call<{ success: boolean }>(
        hubData.handlers,
        'spaceAgent.deleteTemplate',
        { spaceId: 'space-1', key: 'delete.custom' }
      );

      expect(result.success).toBe(true);
      const list = await call<{ templates: Array<{ key: string }> }>(
        hubData.handlers,
        'spaceAgent.listTemplates',
        { spaceId: 'space-1', spaceId: 'space-1' }
      );
      expect(list.templates.map((template) => template.key)).not.toContain('delete.custom');
    });

    it('throws when key is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.deleteTemplate', {
          spaceId: 'space-1',
          spaceId: 'space-1',
        })
      ).rejects.toThrow('key is required');
    });

    it('throws for an unknown key', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgent.deleteTemplate', {
          spaceId: 'space-1',
          key: 'missing.custom',
        })
      ).rejects.toThrow('Template not found: missing.custom');
    });

    it('deletes a template that a workflow slot and a live pinned run both reference', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        spaceId: 'space-1',
        key: 'guard.custom',
        handle: 'guard',
      });
      insertWorkflow(db, 'wf-guard', 'space-1', 'Release');
      const now = Date.now();
      db.prepare(
        `INSERT INTO space_workflow_nodes (id, workflow_id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        'wf-guard-node',
        'wf-guard',
        'Ship',
        JSON.stringify({ agents: [{ agentId: '', templateKey: 'guard.custom', name: 'Guard' }] }),
        now,
        now
      );
      const runRepo = new SpaceWorkflowRunRepository(db as never);
      const run = runRepo.createPinnedRun({
        spaceId: 'space-1',
        workflowId: 'wf-guard',
        title: 'In-flight run',
        rawWorkflow: {
          id: 'wf-guard',
          spaceId: 'space-1',
          name: 'Release',
          nodes: [
            {
              id: 'wf-guard-node',
              name: 'Ship',
              agents: [{ agentId: '', templateKey: 'guard.custom', name: 'Guard' }],
            },
          ],
          startNodeId: 'wf-guard-node',
          tags: [],
          completionAutonomyLevel: 3,
          createdAt: now,
          updatedAt: now,
        } as never,
      });
      expect(run.definitionVersion).not.toBeNull();

      const result = await call<{ success: boolean }>(
        hubData.handlers,
        'spaceAgent.deleteTemplate',
        { spaceId: 'space-1', key: 'guard.custom' }
      );

      expect(result.success).toBe(true);
      const list = await call<{ templates: Array<{ key: string }> }>(
        hubData.handlers,
        'spaceAgent.listTemplates',
        { spaceId: 'space-1', spaceId: 'space-1' }
      );
      expect(list.templates.map((template) => template.key)).not.toContain('guard.custom');
      expect(runRepo.getRun(run.id)?.definitionVersion).toBe(run.definitionVersion);
    });
    it('rejects a delete whose expected version is stale', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        spaceId: 'space-1',
        key: 'guard.custom',
        handle: 'guard',
      });

      await expect(
        call(hubData.handlers, 'spaceAgent.deleteTemplate', {
          spaceId: 'space-1',
          key: 'guard.custom',
          expectedVersion: 99,
        })
      ).rejects.toThrow('modified concurrently');

      const current = await call<{ success: boolean }>(
        hubData.handlers,
        'spaceAgent.deleteTemplate',
        { spaceId: 'space-1', key: 'guard.custom', expectedVersion: 1 }
      );
      expect(current.success).toBe(true);
    });

    it('deletes a template that live agent instances were created from', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        spaceId: 'space-1',
        key: 'guard.custom',
        handle: 'guard',
      });
      const scribe = longHorizonRepo.create({
        spaceId: 'space-1',
        handle: 'scribe',
        displayName: 'Scribe',
        templateKey: 'guard.custom',
        instructions: 'Take notes.',
      });

      const result = await call<{ success: boolean }>(
        hubData.handlers,
        'spaceAgent.deleteTemplate',
        { spaceId: 'space-1', key: 'guard.custom' }
      );

      expect(result.success).toBe(true);
      expect(longHorizonRepo.getById(scribe.id)?.displayName).toBe('Scribe');
      expect(longHorizonRepo.getById(scribe.id)?.instructions).toBe('Take notes.');
    });

    it('clears the template key on archived instances when the template is deleted', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        spaceId: 'space-1',
        key: 'guard.custom',
        handle: 'guard',
      });
      longHorizonRepo.create({
        spaceId: 'space-1',
        handle: 'old-scribe',
        displayName: 'Old Scribe',
        templateKey: 'guard.custom',
        instructions: 'Take notes.',
        status: 'archived',
      });

      const archived = longHorizonRepo.create({
        spaceId: 'space-1',
        handle: 'older-scribe',
        displayName: 'Older Scribe',
        templateKey: 'guard.custom',
        instructions: 'Take notes.',
        status: 'archived',
      });

      const result = await call<{ success: boolean }>(
        hubData.handlers,
        'spaceAgent.deleteTemplate',
        { spaceId: 'space-1', key: 'guard.custom' }
      );
      expect(result.success).toBe(true);
      expect(longHorizonRepo.getById(archived.id)?.templateKey).toBeNull();
    });

    it('rejects a stale expected version on delete', async () => {
      await call(hubData.handlers, 'spaceAgent.createTemplate', {
        spaceId: 'space-1',
        key: 'cas.custom',
        handle: 'cas',
      });
      await call(hubData.handlers, 'spaceAgent.updateTemplate', {
        spaceId: 'space-1',
        key: 'cas.custom',
        displayName: 'Two',
      });

      await expect(
        call(hubData.handlers, 'spaceAgent.deleteTemplate', {
          spaceId: 'space-1',
          key: 'cas.custom',
          expectedVersion: 1,
        })
      ).rejects.toThrow('modified concurrently');

      const result = await call<{ success: boolean }>(
        hubData.handlers,
        'spaceAgent.deleteTemplate',
        { spaceId: 'space-1', key: 'cas.custom', expectedVersion: 2 }
      );
      expect(result.success).toBe(true);
    });
  });

  describe('spaceAgent reminders and subscriptions', () => {
    it('registers reminder and subscription CRUD on the spaceAgent namespace', async () => {
      for (const name of [
        'spaceAgent.listReminderCounts',
        'spaceAgent.createReminder',
        'spaceAgent.deleteReminder',
        'spaceAgent.listSubscriptions',
        'spaceAgent.createSubscription',
        'spaceAgent.updateSubscription',
        'spaceAgent.deleteSubscription',
      ]) {
        expect(hubData.handlers.has(name)).toBe(true);
      }
    });

    it('creates and counts reminders through the spaceAgent namespace', async () => {
      const created = longHorizonRepo.create({ spaceId: 'space-1', handle: 'reminder-holder' });

      const { reminder } = await call<{ reminder: { id: string; status: string } }>(
        hubData.handlers,
        'spaceAgent.createReminder',
        {
          spaceId: 'space-1',
          agentId: created.id,
          title: 'Check in',
          triggerType: 'at',
          runAt: Date.now() + 60_000,
        }
      );
      expect(reminder.status).toBe('active');

      const { counts } = await call<{ counts: Record<string, number> }>(
        hubData.handlers,
        'spaceAgent.listReminderCounts',
        { agentIds: [created.id] }
      );
      expect(counts[created.id]).toBe(1);
    });
  });
});
