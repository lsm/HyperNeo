import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { MessageHub, SpaceWorkerAgent, SpaceWorkflow } from '@hyperneo/shared';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import type { SpaceAgentLookup } from '../../../../src/lib/space/managers/space-workflow-manager';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import {
  setupSpaceExportImportHandlers,
  type ImportPreviewResult,
  type ImportExecuteResult,
} from '../../../../src/lib/rpc-handlers/space-export-import-handlers';
import { exportBundle } from '../../../../src/lib/space/export-format';

function createSchema(db: Database): void {
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
		CREATE TABLE spaces (
			id TEXT PRIMARY KEY,
			slug TEXT NOT NULL,
			workspace_path TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			background_context TEXT NOT NULL DEFAULT '',
			instructions TEXT NOT NULL DEFAULT '',
			default_model TEXT,
			allowed_models TEXT NOT NULL DEFAULT '[]',
			session_ids TEXT NOT NULL DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'active',
			config TEXT,
			setting_sources TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_slug ON spaces(slug)`);

  db.exec(`
		CREATE TABLE space_agents (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			handle TEXT DEFAULT NULL,
			status TEXT NOT NULL DEFAULT 'active'
				CHECK(status IN ('active', 'paused', 'archived')),
			description TEXT NOT NULL DEFAULT '',
			model TEXT,
			provider TEXT,
			thinking_level TEXT DEFAULT NULL,
			tools TEXT NOT NULL DEFAULT '[]',
			custom_prompt TEXT,
			template_name TEXT DEFAULT NULL,
			template_hash TEXT DEFAULT NULL,
			setting_sources TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);

  db.exec(`
		CREATE TABLE space_workflows (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			start_node_id TEXT,
			end_node_id TEXT,
			tags TEXT NOT NULL DEFAULT '[]',
			channels TEXT,
			gates TEXT,
				hooks TEXT,
			layout TEXT,
			template_name TEXT DEFAULT NULL,
			template_hash TEXT DEFAULT NULL,
			instructions TEXT DEFAULT NULL,
			completion_autonomy_level INTEGER NOT NULL DEFAULT 3,
			post_approval TEXT DEFAULT NULL,
			disabled INTEGER NOT NULL DEFAULT 0,
			handle TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_space_workflows_handle
		ON space_workflows(space_id, handle)
		WHERE handle IS NOT NULL
	`);

  db.exec(`
		CREATE TABLE space_workflow_nodes (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
		)
	`);

  db.exec(`
		CREATE TABLE space_workflow_transitions (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			from_node_id TEXT NOT NULL,
			to_node_id TEXT NOT NULL,
			condition TEXT,
			order_index INTEGER NOT NULL DEFAULT 0,
			is_cyclic INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
			FOREIGN KEY (from_node_id) REFERENCES space_workflow_nodes(id) ON DELETE CASCADE,
			FOREIGN KEY (to_node_id) REFERENCES space_workflow_nodes(id) ON DELETE CASCADE
		)
	`);
  db.exec(`
		CREATE TABLE space_workflow_runs (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
  db.exec(`
		CREATE TABLE space_tasks (
			id TEXT PRIMARY KEY,
			workflow_run_id TEXT,
			archived_at INTEGER
		)
	`);
}

function insertSpace(db: Database, id: string, name = `Space ${id}`): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, `/workspace/${id}`, name, id, now, now);
}

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
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
  hub: InternalEventBus<DaemonInternalEventMap>;
  emittedEvents: Array<{ name: string; data: unknown }>;
} {
  const emittedEvents: Array<{ name: string; data: unknown }> = [];
  const hub = {
    publish: mock(async (name: string, data: unknown) => {
      emittedEvents.push({ name, data });
      return { delivered: 0, failures: [] };
    }),
    publishAsync: mock((name: string, data: unknown) => {
      emittedEvents.push({ name, data });
    }),
    subscribe: mock(() => () => {}),
    off: mock(() => {}),
    clear: mock(() => {}),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
  return { hub, emittedEvents };
}

function createMockSpaceManager(spaceId: string, spaceName = 'Test Space'): SpaceManager {
  return {
    getSpace: mock(async (id: string) => {
      if (id === spaceId) {
        return { id, name: spaceName, workspacePath: '/ws', status: 'active' } as any;
      }
      return null;
    }),
  } as unknown as SpaceManager;
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

const SPACE_ID = 'space-1';
const OTHER_SPACE_ID = 'space-2';

describe('Space Export/Import RPC Handlers', () => {
  let db: Database;
  let agentRepo: SpaceAgentRepository;
  let workflowRepo: SpaceWorkflowRepository;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let handlers: Map<string, RequestHandler>;
  let internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  let emittedEvents: Array<{ name: string; data: unknown }>;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    insertSpace(db, SPACE_ID, 'My Space');
    insertSpace(db, OTHER_SPACE_ID, 'Other Space');

    agentRepo = new SpaceAgentRepository(db as any);
    workflowRepo = new SpaceWorkflowRepository(db as any);

    const agentLookup: SpaceAgentLookup = {
      getAgentById(spaceId: string, id: string) {
        const agent = agentRepo.getById(id);
        if (!agent || agent.spaceId !== spaceId) return null;
        return { id: agent.id, name: agent.name };
      },
    };
    workflowManager = new SpaceWorkflowManager(workflowRepo, agentLookup);
    spaceManager = createMockSpaceManager(SPACE_ID);

    const mockHub = createMockHub();
    handlers = mockHub.handlers;

    const mockInternalEventBus = createMockInternalEventBus();
    internalEventBus = mockInternalEventBus.hub;
    emittedEvents = mockInternalEventBus.emittedEvents;

    setupSpaceExportImportHandlers(
      mockHub.hub,
      spaceManager,
      agentRepo,
      workflowRepo,
      workflowManager,
      db as any,
      internalEventBus
    );
  });

  it('registers all 5 handlers', () => {
    expect(handlers.has('spaceExport.agents')).toBe(true);
    expect(handlers.has('spaceExport.workflows')).toBe(true);
    expect(handlers.has('spaceExport.bundle')).toBe(true);
    expect(handlers.has('spaceImport.preview')).toBe(true);
    expect(handlers.has('spaceImport.execute')).toBe(true);
  });

  describe('spaceId validation', () => {
    it.each([
      'spaceExport.agents',
      'spaceExport.workflows',
      'spaceExport.bundle',
    ])('%s: throws if spaceId missing', async (method) => {
      await expect(call(handlers, method, {})).rejects.toThrow('spaceId is required');
    });

    it.each([
      'spaceExport.agents',
      'spaceExport.workflows',
      'spaceExport.bundle',
    ])('%s: throws if space not found', async (method) => {
      await expect(call(handlers, method, { spaceId: 'nonexistent' })).rejects.toThrow(
        'Space not found: nonexistent'
      );
    });

    it('spaceImport.preview: throws if spaceId missing', async () => {
      await expect(call(handlers, 'spaceImport.preview', { bundle: {} })).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('spaceImport.execute: throws if spaceId missing', async () => {
      await expect(call(handlers, 'spaceImport.execute', { bundle: {} })).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('spaceImport.execute: throws if space not found', async () => {
      await expect(
        call(handlers, 'spaceImport.execute', { spaceId: 'ghost', bundle: {} })
      ).rejects.toThrow('Space not found: ghost');
    });
  });

  describe('spaceExport.agents', () => {
    it('exports all agents when no filter provided', async () => {
      agentRepo.create({ spaceId: SPACE_ID, name: 'Alpha' });
      agentRepo.create({ spaceId: SPACE_ID, name: 'Beta' });

      const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.agents', {
        spaceId: SPACE_ID,
      });

      expect(bundle.type).toBe('bundle');
      expect(bundle.agents).toHaveLength(2);
      expect(bundle.agents.map((a: any) => a.name)).toEqual(
        expect.arrayContaining(['Alpha', 'Beta'])
      );
      expect(bundle.workflows).toHaveLength(0);
    });

    it('filters agents by agentIds', async () => {
      const a1 = agentRepo.create({ spaceId: SPACE_ID, name: 'Alpha' });
      agentRepo.create({ spaceId: SPACE_ID, name: 'Beta' });

      const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.agents', {
        spaceId: SPACE_ID,
        agentIds: [a1.id],
      });

      expect(bundle.agents).toHaveLength(1);
      expect(bundle.agents[0].name).toBe('Alpha');
    });

    it('exported agent preserves fields and strips id/spaceId', async () => {
      agentRepo.create({
        spaceId: SPACE_ID,
        name: 'Coder',
        handle: 'feature-coder',
        model: 'claude-3',
        customPrompt: 'You code.',
        tools: ['read_file'],
      });

      const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.agents', {
        spaceId: SPACE_ID,
      });

      const exported = bundle.agents[0];
      expect(exported.name).toBe('Coder');
      expect(exported.handle).toBe('feature-coder');
      expect(exported.model).toBe('claude-3');
      expect(exported.systemPrompt).toBe('You code.');
      expect(exported.tools).toEqual(['read_file']);
      expect(exported.id).toBeUndefined();
      expect(exported.spaceId).toBeUndefined();
      expect(exported.version).toBe(3);
      expect(exported.type).toBe('agent');
    });

    it('sets exportedFrom to spaceId', async () => {
      agentRepo.create({ spaceId: SPACE_ID, name: 'A' });
      const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.agents', {
        spaceId: SPACE_ID,
      });
      expect(bundle.exportedFrom).toBe(SPACE_ID);
    });

    it('returns empty agents array when no agents exist', async () => {
      const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.agents', {
        spaceId: SPACE_ID,
      });
      expect(bundle.agents).toHaveLength(0);
    });
  });

  describe('spaceExport.workflows', () => {
    it('exports workflow with agentRef resolved to agent name', async () => {
      const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'Coder' });
      workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'Pipeline',
        nodes: [{ name: 'Code', agentId: agent.id }],
        transitions: [],
        completionAutonomyLevel: 3,
      });

      const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.workflows', {
        spaceId: SPACE_ID,
      });

      expect(bundle.workflows).toHaveLength(1);
      const wf = bundle.workflows[0];
      expect(wf.name).toBe('Pipeline');
      expect(wf.nodes[0].agents[0].agentRef).toBe('Coder');
      expect(wf.nodes[0].name).toBe('Code');
    });

    it('exports static external event interests for agent slots', async () => {
      const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'Coder' });
      workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'Pipeline',
        nodes: [
          {
            name: 'Code',
            agents: [
              {
                agentId: agent.id,
                name: 'Coder',
                eventInterests: [
                  {
                    topic: 'github/*/*/pull_request/*.review_*',
                    label: 'PR reviews',
                  },
                ],
              },
            ],
          },
        ],
        transitions: [],
        completionAutonomyLevel: 3,
      });

      const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.workflows', {
        spaceId: SPACE_ID,
      });

      expect(bundle.workflows[0].nodes[0].agents[0].eventInterests).toEqual([
        {
          topic: 'github/*/*/pull_request/*.review_*',
          label: 'PR reviews',
        },
      ]);
    });

    it('includes only referenced agents in the bundle', async () => {
      const coder = agentRepo.create({ spaceId: SPACE_ID, name: 'Coder' });
      agentRepo.create({ spaceId: SPACE_ID, name: 'Reviewer' });
      workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'Pipeline',
        nodes: [{ name: 'Code', agentId: coder.id }],
        transitions: [],
        completionAutonomyLevel: 3,
      });

      const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.workflows', {
        spaceId: SPACE_ID,
      });

      expect(bundle.agents).toHaveLength(1);
      expect(bundle.agents[0].name).toBe('Coder');
    });

    it('filters workflows by workflowIds', async () => {
      const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'A' });
      const wf1 = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'WF1',
        nodes: [{ name: 'S1', agentId: agent.id }],
        transitions: [],
        completionAutonomyLevel: 3,
      });
      workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'WF2',
        nodes: [{ name: 'S2', agentId: agent.id }],
        transitions: [],
        completionAutonomyLevel: 3,
      });

      const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.workflows', {
        spaceId: SPACE_ID,
        workflowIds: [wf1.id],
      });

      expect(bundle.workflows).toHaveLength(1);
      expect(bundle.workflows[0].name).toBe('WF1');
    });
  });

  describe('spaceExport.bundle', () => {
    it('exports all agents and workflows', async () => {
      const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'A' });
      workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'W',
        nodes: [{ name: 'S', agentId: agent.id }],
        transitions: [],
        completionAutonomyLevel: 3,
      });

      const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.bundle', {
        spaceId: SPACE_ID,
      });

      expect(bundle.type).toBe('bundle');
      expect(bundle.agents).toHaveLength(1);
      expect(bundle.workflows).toHaveLength(1);
    });

    it('filters by agentIds and workflowIds', async () => {
      const a1 = agentRepo.create({ spaceId: SPACE_ID, name: 'A1' });
      agentRepo.create({ spaceId: SPACE_ID, name: 'A2' });
      const wf1 = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'W1',
        nodes: [{ name: 'S', agentId: a1.id }],
        transitions: [],
        completionAutonomyLevel: 3,
      });
      workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'W2',
        nodes: [{ name: 'S', agentId: a1.id }],
        transitions: [],
        completionAutonomyLevel: 3,
      });

      const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.bundle', {
        spaceId: SPACE_ID,
        agentIds: [a1.id],
        workflowIds: [wf1.id],
      });

      expect(bundle.agents).toHaveLength(1);
      expect(bundle.agents[0].name).toBe('A1');
      expect(bundle.workflows).toHaveLength(1);
      expect(bundle.workflows[0].name).toBe('W1');
    });
  });

  describe('spaceImport.preview', () => {
    it('returns validation error for invalid bundle', async () => {
      const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
        spaceId: SPACE_ID,
        bundle: { not: 'a bundle' },
      });

      expect(result.agents).toHaveLength(0);
      expect(result.workflows).toHaveLength(0);
      expect(result.validationErrors.length).toBeGreaterThan(0);
    });

    it('returns create action for non-conflicting items', async () => {
      const bundle = makeBundle([{ name: 'Coder', role: 'coder' }], []);

      const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
        spaceId: SPACE_ID,
        bundle,
      });

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]).toEqual({ name: 'Coder', action: 'create' });
      expect(result.validationErrors).toHaveLength(0);
    });

    it('detects agent name conflict', async () => {
      const existing = agentRepo.create({ spaceId: SPACE_ID, name: 'Coder' });
      const bundle = makeBundle([{ name: 'Coder', role: 'coder' }], []);

      const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
        spaceId: SPACE_ID,
        bundle,
      });

      expect(result.agents[0]).toEqual({
        name: 'Coder',
        action: 'conflict',
        existingId: existing.id,
      });
    });

    it('detects workflow name conflict', async () => {
      const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'A' });
      const existing = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'Pipeline',
        nodes: [{ name: 'S', agentId: agent.id }],
        transitions: [],
        completionAutonomyLevel: 3,
      });

      const bundle = makeBundle(
        [{ name: 'A', role: 'coder' }],
        [{ name: 'Pipeline', nodes: [{ agentRef: 'A', name: 'S' }] }]
      );

      const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
        spaceId: SPACE_ID,
        bundle,
      });

      expect(result.workflows[0]).toEqual({
        name: 'Pipeline',
        action: 'conflict',
        existingId: existing.id,
      });
    });

    it('flags unresolved agent ref as validation error', async () => {
      const bundle = makeBundle(
        [],
        [{ name: 'Pipeline', nodes: [{ agentRef: 'Ghost', name: 'S' }] }]
      );

      const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
        spaceId: SPACE_ID,
        bundle,
      });

      expect(result.validationErrors.length).toBeGreaterThan(0);
      expect(result.validationErrors[0]).toContain('Ghost');
      expect(result.validationErrors[0]).toContain('Pipeline');
    });

    it('resolves agent ref from existing space agents', async () => {
      agentRepo.create({ spaceId: SPACE_ID, name: 'ExistingAgent' });
      const bundle = makeBundle(
        [],
        [{ name: 'Pipeline', nodes: [{ agentRef: 'ExistingAgent', name: 'S' }] }]
      );

      const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
        spaceId: SPACE_ID,
        bundle,
      });

      expect(result.validationErrors).toHaveLength(0);
    });

    it('passes validation for always condition', async () => {
      const bundle = makeBundleWithCondition('always', undefined);

      const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
        spaceId: SPACE_ID,
        bundle,
      });

      expect(result.validationErrors).toHaveLength(0);
    });
  });

  describe('spaceImport.execute', () => {
    it('throws for invalid bundle', async () => {
      await expect(
        call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle: { bad: true } })
      ).rejects.toThrow('Invalid bundle');
    });

    it('drops a legacy empty gate instead of rolling back the import', async () => {
      const bundle = {
        version: 3,
        type: 'bundle',
        name: 'B',
        agents: [{ version: 3, type: 'agent', name: 'Coder' }],
        workflows: [
          {
            version: 3,
            type: 'workflow',
            name: 'Pipeline',
            nodes: [{ agents: [{ agentRef: 'Coder', name: 'Coder' }], name: 'Code' }],
            startNode: 'Code',
            tags: [],
            gates: [{ id: 'empty', resetOnCycle: false }],
          },
        ],
        exportedAt: 1000,
      };

      const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
        spaceId: SPACE_ID,
        bundle,
      });
      const workflow = workflowRepo.getWorkflow(result.workflows[0].id)!;
      expect(workflow).toBeTruthy();
      expect(workflow.gates ?? []).toEqual([]);
    });

    it('imports static external event interests for agent slots', async () => {
      const bundle = makeBundle(
        [{ name: 'Coder', role: 'coder' }],
        [
          {
            name: 'Pipeline',
            nodes: [
              {
                agentRef: 'Coder',
                name: 'Code',
                eventInterests: [
                  {
                    topic: 'github/*/*/pull_request/*.review_*',
                    label: 'PR reviews',
                  },
                ],
              },
            ],
          },
        ]
      );

      const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
        spaceId: SPACE_ID,
        bundle,
      });

      const workflow = workflowRepo.getWorkflow(result.workflows[0].id)!;
      expect(workflow.nodes[0].agents[0].eventInterests).toEqual([
        {
          topic: 'github/*/*/pull_request/*.review_*',
          label: 'PR reviews',
        },
      ]);
    });

    it('rejects invalid static external event interest topics during import', async () => {
      const bundle = makeBundle(
        [{ name: 'Coder', role: 'coder' }],
        [
          {
            name: 'Pipeline',
            nodes: [
              {
                agentRef: 'Coder',
                name: 'Code',
                eventInterests: [{ topic: 'github/**/pull_request/*.opened' }],
              },
            ],
          },
        ]
      );

      await expect(
        call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle })
      ).rejects.toThrow('Invalid bundle');
    });

    it('rejects too many static external event interests during import', async () => {
      const bundle = makeBundle(
        [{ name: 'Coder', role: 'coder' }],
        [
          {
            name: 'Pipeline',
            nodes: [
              {
                agentRef: 'Coder',
                name: 'Code',
                eventInterests: Array.from({ length: 11 }, (_, index) => ({
                  topic: `github/*/*/pull_request_${index}.opened`,
                })),
              },
            ],
          },
        ]
      );

      await expect(
        call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle })
      ).rejects.toThrow('Invalid bundle');
    });

    it('creates agents and workflows with no conflicts', async () => {
      const bundle = makeBundle(
        [{ name: 'Coder', handle: 'feature-coder', role: 'coder', customPrompt: 'You code.' }],
        [{ name: 'Pipeline', nodes: [{ agentRef: 'Coder', name: 'Code' }] }]
      );

      const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
        spaceId: SPACE_ID,
        bundle,
      });

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]).toMatchObject({ name: 'Coder', action: 'created' });
      expect(result.workflows).toHaveLength(1);
      expect(result.workflows[0]).toMatchObject({ name: 'Pipeline', action: 'created' });

      const agents = agentRepo.getBySpaceId(SPACE_ID);
      const importedAgent = agents.find((a) => a.name === 'Coder');
      expect(importedAgent?.customPrompt).toBe('You code.');
      expect(importedAgent?.handle).toBe('feature-coder');
      const workflows = workflowRepo.listWorkflows(SPACE_ID);
      expect(workflows.find((w) => w.name === 'Pipeline')).toBeTruthy();
    });

    describe('conflict resolution: skip', () => {
      it('skips conflicting agent and uses existing UUID for workflow cross-refs', async () => {
        const existing = agentRepo.create({ spaceId: SPACE_ID, name: 'Coder' });

        const bundle = makeBundle(
          [{ name: 'Coder', role: 'reviewer' }],
          [{ name: 'Pipeline', nodes: [{ agentRef: 'Coder', name: 'Code' }] }]
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { Coder: 'skip' } },
        });

        expect(result.agents[0]).toMatchObject({
          name: 'Coder',
          action: 'skipped',
          id: existing.id,
        });

        agentRepo.getById(existing.id)!;

        expect(result.workflows[0].action).toBe('created');
        const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
        expect(wf.nodes[0].agents![0].agentId).toBe(existing.id);
      });

      it('skips conflicting workflow', async () => {
        const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'A' });
        const existingWf = workflowManager.createWorkflow({
          spaceId: SPACE_ID,
          name: 'Pipeline',
          nodes: [{ name: 'S', agentId: agent.id }],
          transitions: [],
          completionAutonomyLevel: 3,
        });

        const bundle = makeBundle(
          [{ name: 'A', role: 'coder' }],
          [{ name: 'Pipeline', nodes: [{ agentRef: 'A', name: 'S' }] }]
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { A: 'skip' }, workflows: { Pipeline: 'skip' } },
        });

        expect(result.workflows[0]).toMatchObject({
          name: 'Pipeline',
          action: 'skipped',
          id: existingWf.id,
        });

        const all = workflowRepo.listWorkflows(SPACE_ID);
        expect(all).toHaveLength(1);
      });
    });

    describe('conflict resolution: rename', () => {
      it('renames conflicting agent with unique name', async () => {
        agentRepo.create({ spaceId: SPACE_ID, name: 'Coder' });
        agentRepo.create({ spaceId: SPACE_ID, name: 'Coder (1)' });

        const bundle = makeBundle([{ name: 'Coder', handle: 'reviewer', role: 'reviewer' }], []);

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { Coder: 'rename' } },
        });

        expect(result.agents[0]).toMatchObject({ name: 'Coder (2)', action: 'renamed' });

        const agents = agentRepo.getBySpaceId(SPACE_ID);
        expect(agents.map((a) => a.name)).toContain('Coder');
        const renamedAgent = agents.find((a) => a.name === 'Coder (2)');
        expect(renamedAgent?.handle).toBe('reviewer');
      });

      it('auto-generates an imported agent handle and warns when exported handle conflicts', async () => {
        agentRepo.create({ spaceId: SPACE_ID, name: 'Local Reviewer', handle: 'reviewer' });

        const bundle = makeBundle([{ name: 'Reviewer', handle: 'reviewer', role: 'reviewer' }], []);

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
        });

        expect(result.agents[0]).toMatchObject({ name: 'Reviewer', action: 'created' });
        expect(result.warnings).toContain(
          'Agent "Reviewer": exported handle "reviewer" already exists in the target space; a new handle was auto-generated'
        );

        const importedAgent = agentRepo.getById(result.agents[0].id)!;
        expect(importedAgent.handle).toBe('reviewer-2');
      });

      it('auto-generates an imported agent handle and warns when exported handle is reserved', async () => {
        const bundle = makeBundle(
          [{ name: 'Coordinator', handle: 'coordinator', role: 'coordinator' }],
          []
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
        });

        expect(result.agents[0]).toMatchObject({ name: 'Coordinator', action: 'created' });
        expect(result.warnings).toContain(
          'Agent "Coordinator": exported handle "coordinator" is reserved; a new handle was auto-generated'
        );

        const importedAgent = agentRepo.getById(result.agents[0].id)!;
        expect(importedAgent.handle).toBe('coordinator-2');
      });

      it('renames conflicting workflow', async () => {
        const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'A' });
        workflowManager.createWorkflow({
          spaceId: SPACE_ID,
          name: 'Pipeline',
          nodes: [{ name: 'S', agentId: agent.id }],
          transitions: [],
          completionAutonomyLevel: 3,
        });

        const bundle = makeBundle(
          [{ name: 'A', role: 'coder' }],
          [{ name: 'Pipeline', nodes: [{ agentRef: 'A', name: 'S2' }] }]
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { A: 'skip' }, workflows: { Pipeline: 'rename' } },
        });

        expect(result.workflows[0]).toMatchObject({ name: 'Pipeline (1)', action: 'renamed' });

        const all = workflowRepo.listWorkflows(SPACE_ID);
        expect(all).toHaveLength(2);
        expect(all.map((w) => w.name)).toContain('Pipeline (1)');
      });
    });

    describe('conflict resolution: replace', () => {
      it('replaces conflicting agent in place (preserves UUID)', async () => {
        const existing = agentRepo.create({ spaceId: SPACE_ID, name: 'Coder' });

        const bundle = makeBundle(
          [{ name: 'Coder', handle: 'reviewer', role: 'reviewer', model: 'claude-new' }],
          []
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { Coder: 'replace' } },
        });

        expect(result.agents[0]).toMatchObject({
          name: 'Coder',
          action: 'replaced',
          id: existing.id,
        });

        const agent = agentRepo.getById(existing.id)!;
        expect(agent.model).toBe('claude-new');
        expect(agent.handle).toBe('reviewer');
      });

      it('clears the session provider when a replace import drops the override (P2)', async () => {
        const runtimeService = {
          clearLongTermAgentSessionProvider: mock(async () => {}),
        };
        const freshHub = createMockHub();
        setupSpaceExportImportHandlers(
          freshHub.hub,
          spaceManager,
          agentRepo,
          workflowRepo,
          workflowManager,
          db as any,
          internalEventBus,
          runtimeService
        );

        const existing = agentRepo.create({
          spaceId: SPACE_ID,
          name: 'Coder',
          provider: 'openrouter',
        } as never);
        const bundle = makeBundle([{ name: 'Coder', handle: 'reviewer', model: 'claude-new' }], []);

        const result = await call<ImportExecuteResult>(freshHub.handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { Coder: 'replace' } },
        });

        expect(result.agents[0]).toMatchObject({ name: 'Coder', action: 'replaced' });
        expect(runtimeService.clearLongTermAgentSessionProvider).toHaveBeenCalledWith(
          SPACE_ID,
          existing.id
        );
      });

      it('preserves swapped handles when replacing multiple agents', async () => {
        const existingA = agentRepo.create({ spaceId: SPACE_ID, name: 'A', handle: 'a' });
        const existingB = agentRepo.create({ spaceId: SPACE_ID, name: 'B', handle: 'b' });

        const bundle = makeBundle(
          [
            { name: 'A', handle: 'b', model: 'claude-new-a' },
            { name: 'B', handle: 'a', model: 'claude-new-b' },
          ],
          []
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { A: 'replace', B: 'replace' } },
        });

        expect(result.warnings).toHaveLength(0);
        expect(result.agents).toEqual([
          { name: 'A', id: existingA.id, action: 'replaced' },
          { name: 'B', id: existingB.id, action: 'replaced' },
        ]);

        expect(agentRepo.getById(existingA.id)?.handle).toBe('b');
        expect(agentRepo.getById(existingB.id)?.handle).toBe('a');
      });

      it('reserves fallback handles when replace cannot preserve exported handle', async () => {
        const existingA = agentRepo.create({ spaceId: SPACE_ID, name: 'A', handle: 'a' });

        const bundle = makeBundle(
          [
            { name: 'A', handle: 'coordinator', model: 'claude-new-a' },
            { name: 'New Agent', handle: 'a', model: 'claude-new-b' },
          ],
          []
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { A: 'replace' } },
        });

        expect(result.warnings).toContain(
          'Agent "A": exported handle "coordinator" is reserved; a new handle was auto-generated'
        );
        expect(result.warnings).toContain(
          'Agent "New Agent": exported handle "a" already exists in the target space; a new handle was auto-generated'
        );

        expect(agentRepo.getById(existingA.id)?.handle).toBe('a');
        const newAgent = agentRepo.getById(result.agents.find((a) => a.name === 'New Agent')!.id)!;
        expect(newAgent.handle).toBe('new-agent');
      });

      it('generates a new fallback handle when another replacement claims the old one', async () => {
        const existingA = agentRepo.create({ spaceId: SPACE_ID, name: 'A', handle: 'a' });
        const existingB = agentRepo.create({ spaceId: SPACE_ID, name: 'B', handle: 'b' });

        const bundle = makeBundle(
          [
            { name: 'A', handle: 'b', model: 'claude-new-a' },
            { name: 'B', handle: 'coordinator', model: 'claude-new-b' },
          ],
          []
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { A: 'replace', B: 'replace' } },
        });

        expect(result.agents).toEqual([
          { name: 'A', id: existingA.id, action: 'replaced' },
          { name: 'B', id: existingB.id, action: 'replaced' },
        ]);
        expect(result.warnings).toContain(
          'Agent "B": exported handle "coordinator" is reserved; a new handle was auto-generated'
        );
        expect(agentRepo.getById(existingA.id)?.handle).toBe('b');
        expect(agentRepo.getById(existingB.id)?.handle).toBe('b-2');
      });

      it('generates legacy create handles from batch reservations', async () => {
        const existingA = agentRepo.create({ spaceId: SPACE_ID, name: 'A', handle: 'a' });

        const bundle = makeBundle(
          [
            { name: 'New Agent', model: 'claude-new' },
            { name: 'A', handle: 'new-agent', model: 'claude-new-a' },
          ],
          []
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { A: 'replace' } },
        });

        const newAgent = agentRepo.getById(result.agents.find((a) => a.name === 'New Agent')!.id)!;
        expect(newAgent.handle).toBe('new-agent-2');
        expect(agentRepo.getById(existingA.id)?.handle).toBe('new-agent');
      });

      it('replaces conflicting workflow (delete + create)', async () => {
        const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'A' });
        workflowManager.createWorkflow({
          spaceId: SPACE_ID,
          name: 'Pipeline',
          nodes: [{ name: 'OldStep', agentId: agent.id }],
          transitions: [],
          completionAutonomyLevel: 3,
        });

        const bundle = makeBundle(
          [{ name: 'A', role: 'coder' }],
          [{ name: 'Pipeline', nodes: [{ agentRef: 'A', name: 'NewStep' }] }]
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { A: 'skip' }, workflows: { Pipeline: 'replace' } },
        });

        expect(result.workflows[0]).toMatchObject({ name: 'Pipeline', action: 'replaced' });

        const all = workflowRepo.listWorkflows(SPACE_ID);
        expect(all).toHaveLength(1);
        expect(all[0].nodes[0].name).toBe('NewStep');
      });

      it('SKIPS replace when the existing workflow has a non-archived run (RFC §4 #3)', async () => {
        const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'A' });
        const existing = workflowManager.createWorkflow({
          spaceId: SPACE_ID,
          name: 'Pipeline',
          nodes: [{ name: 'OldStep', agentId: agent.id }],
          transitions: [],
          completionAutonomyLevel: 3,
        });
        const now = Date.now();
        const runId = 'run-with-live-task';
        (db as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => void } })
          .prepare(
            `INSERT INTO space_workflow_runs (id, workflow_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
          )
          .run(runId, existing.id, now, now);
        (db as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => void } })
          .prepare(`INSERT INTO space_tasks (id, workflow_run_id, archived_at) VALUES (?, ?, NULL)`)
          .run('task-live', runId);

        const bundle = makeBundle(
          [{ name: 'A', role: 'coder' }],
          [{ name: 'Pipeline', nodes: [{ agentRef: 'A', name: 'NewStep' }] }]
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { A: 'skip' }, workflows: { Pipeline: 'replace' } },
        });

        expect(result.workflows[0]).toMatchObject({ name: 'Pipeline', action: 'skipped' });
        expect(result.warnings.some((w) => w.includes('not archived'))).toBe(true);
        const all = workflowRepo.listWorkflows(SPACE_ID);
        expect(all).toHaveLength(1);
        expect(all[0].id).toBe(existing.id);
        expect(all[0].nodes[0].name).toBe('OldStep');
      });
    });

    describe('cross-reference mapping', () => {
      it('resolves agent name→UUID from bundle agents', async () => {
        const bundle = makeBundle(
          [{ name: 'BundleAgent', role: 'coder' }],
          [{ name: 'Pipeline', nodes: [{ agentRef: 'BundleAgent', name: 'S' }] }]
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
        });

        const importedAgentId = result.agents[0].id;
        const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
        expect(wf.nodes[0].agents![0].agentId).toBe(importedAgentId);
      });

      it('resolves agent name→UUID from existing space agents (not in bundle)', async () => {
        const existing = agentRepo.create({ spaceId: SPACE_ID, name: 'LocalAgent' });

        const bundle = makeBundle(
          [],
          [{ name: 'Pipeline', nodes: [{ agentRef: 'LocalAgent', name: 'S' }] }]
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
        });

        const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
        expect(wf.nodes[0].agents![0].agentId).toBe(existing.id);
      });

      it('prefers bundle agent over existing space agent of same name', async () => {
        const existingAgent = agentRepo.create({ spaceId: SPACE_ID, name: 'Agent' });

        const bundle = makeBundle(
          [{ name: 'Agent', role: 'reviewer' }],
          [{ name: 'Pipeline', nodes: [{ agentRef: 'Agent', name: 'S' }] }]
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { Agent: 'skip' } },
        });

        const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
        expect(wf.nodes[0].agents![0].agentId).toBe(existingAgent.id);
      });

      it('throws when agent ref cannot be resolved', async () => {
        const bundle = makeBundle(
          [],
          [{ name: 'Pipeline', nodes: [{ agentRef: 'GhostAgent', name: 'S' }] }]
        );

        await expect(
          call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle })
        ).rejects.toThrow('unresolved agent reference');
      });

      it('imports bundle with startNode and assigns fresh UUIDs to nodes', async () => {
        const bundleWithRules = makeBundleWithRules();

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle: bundleWithRules,
        });

        const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
        const codeStep = wf.nodes.find((s) => s.name === 'Code')!;
        expect(codeStep).toBeTruthy();
        expect(codeStep.id).toMatch(/^[0-9a-f-]{36}$/i);
        expect(wf.startNodeId).toBe(codeStep.id);
      });

      it('assigns fresh step UUIDs (not re-using exported names as IDs)', async () => {
        const bundle = makeBundle(
          [{ name: 'A', role: 'coder' }],
          [{ name: 'W', nodes: [{ agentRef: 'A', name: 'MyStep' }] }]
        );

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
        });

        const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
        const stepId = wf.nodes[0].id;
        expect(stepId).toMatch(/^[0-9a-f-]{36}$/i);
        expect(stepId).not.toBe('MyStep');
      });
    });

    it('imports workflow with multiple steps', async () => {
      const bundle = makeTwoStepBundle();

      const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
        spaceId: SPACE_ID,
        bundle,
      });

      expect(result.agents).toHaveLength(2);
      const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
      expect(wf.nodes).toHaveLength(2);
      expect(wf.nodes.find((s) => s.name === 'Code')).toBeTruthy();
      expect(wf.nodes.find((s) => s.name === 'Review')).toBeTruthy();
    });

    it('returns empty warnings array on clean import', async () => {
      const bundle = makeBundle(
        [{ name: 'A', role: 'coder' }],
        [{ name: 'W', nodes: [{ agentRef: 'A', name: 'S' }] }]
      );

      const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
        spaceId: SPACE_ID,
        bundle,
      });

      expect(result.warnings).toHaveLength(0);
    });

    describe('transaction atomicity', () => {
      it('rolls back agent creation when workflow import fails (unresolved agent ref)', async () => {
        const bundle = {
          version: 1,
          type: 'bundle',
          name: 'Atomic Test',
          agents: [{ version: 1, type: 'agent', name: 'NewAgent' }],
          workflows: [
            {
              version: 1,
              type: 'workflow',
              name: 'BadWorkflow',
              nodes: [{ agents: [{ agentRef: 'GhostAgent', name: 'GhostAgent' }], name: 'S' }],
              startNode: 'S',
              tags: [],
            },
          ],
          exportedAt: Date.now(),
        };

        await expect(
          call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle })
        ).rejects.toThrow('unresolved agent reference');

        const agents = agentRepo.getBySpaceId(SPACE_ID);
        expect(agents.find((a) => a.name === 'NewAgent')).toBeUndefined();
      });

      it('rolls back workflow deletion when replacement creation fails', async () => {
        const existingAgent = agentRepo.create({ spaceId: SPACE_ID, name: 'A' });
        const existingWf = workflowManager.createWorkflow({
          spaceId: SPACE_ID,
          name: 'ToReplace',
          nodes: [{ name: 'S', agentId: existingAgent.id }],
          transitions: [],
          completionAutonomyLevel: 3,
        });

        const bundle = {
          version: 1,
          type: 'bundle',
          name: 'Replace Test',
          agents: [],
          workflows: [
            {
              version: 1,
              type: 'workflow',
              name: 'ToReplace',
              nodes: [{ agents: [{ agentRef: 'GhostAgent', name: 'GhostAgent' }], name: 'S2' }],
              startNode: 'S2',
              tags: [],
            },
          ],
          exportedAt: Date.now(),
        };

        await expect(
          call(handlers, 'spaceImport.execute', {
            spaceId: SPACE_ID,
            bundle,
            conflictResolution: { workflows: { ToReplace: 'replace' } },
          })
        ).rejects.toThrow('unresolved agent reference');

        const wf = workflowRepo.getWorkflow(existingWf.id);
        expect(wf).not.toBeNull();
        expect(wf!.name).toBe('ToReplace');
      });
    });

    describe('replace agent: unset fields are cleared', () => {
      it('clears model when not present in exported agent', async () => {
        const existing = agentRepo.create({
          spaceId: SPACE_ID,
          name: 'Coder',
          role: 'coder',
          model: 'old-model',
        });

        const bundle = makeBundle([{ name: 'Coder', role: 'reviewer' }], []);

        await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { Coder: 'replace' } },
        });

        const agent = agentRepo.getById(existing.id)!;
        expect(agent.model).toBeUndefined();
      });

      it('clears customPrompt when not present in exported agent', async () => {
        const existing = agentRepo.create({
          spaceId: SPACE_ID,
          name: 'Coder',
          customPrompt: 'Old prompt.',
        });

        const bundle = makeBundle([{ name: 'Coder', role: 'coder' }], []);

        await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { Coder: 'replace' } },
        });

        const agent = agentRepo.getById(existing.id)!;
        expect(agent.customPrompt).toBeNull();
      });

      it('replaces thinkingLevel when present in exported agent', async () => {
        const existing = agentRepo.create({
          spaceId: SPACE_ID,
          name: 'Coder',
          thinkingLevel: 'think8k',
        });

        const bundle = makeBundle([{ name: 'Coder', thinkingLevel: 'think16k' }], []);

        await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { Coder: 'replace' } },
        });

        const agent = agentRepo.getById(existing.id)!;
        expect(agent.thinkingLevel).toBe('think16k');
      });

      it('clears thinkingLevel when not present in exported agent', async () => {
        const existing = agentRepo.create({
          spaceId: SPACE_ID,
          name: 'Coder',
          thinkingLevel: 'think16k',
        });

        const bundle = makeBundle([{ name: 'Coder', role: 'coder' }], []);

        await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
          conflictResolution: { agents: { Coder: 'replace' } },
        });

        const agent = agentRepo.getById(existing.id)!;
        expect(agent.thinkingLevel).toBeUndefined();
      });

      it('normalizes legacy auto thinkingLevel to off during import', async () => {
        const bundle = makeBundle([{ name: 'Coder', thinkingLevel: 'auto' }], []);

        const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
          spaceId: SPACE_ID,
          bundle,
        });

        const agent = agentRepo.getById(result.agents[0].id)!;
        expect(agent.thinkingLevel).toBe('off');
      });
    });
  });

  describe('event emission after spaceImport.execute', () => {
    it('emits spaceAgent.created for each newly created agent', async () => {
      const bundle = makeBundle([{ name: 'NewAgent', role: 'coder' }], []);

      await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
        spaceId: SPACE_ID,
        bundle,
      });

      await Promise.resolve();

      const agentCreated = emittedEvents.filter((e) => e.name === 'spaceAgent.created');
      expect(agentCreated).toHaveLength(1);
      expect((agentCreated[0].data as { spaceId: string }).spaceId).toBe(SPACE_ID);
      expect((agentCreated[0].data as { agent: { name: string } }).agent.name).toBe('NewAgent');
    });

    it('emits spaceAgent.updated for replaced agent', async () => {
      agentRepo.create({ spaceId: SPACE_ID, name: 'Coder' });
      const bundle = makeBundle([{ name: 'Coder', role: 'coder', model: 'claude-haiku-4-5' }], []);

      await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
        spaceId: SPACE_ID,
        bundle,
        conflictResolution: { agents: { Coder: 'replace' } },
      });

      await Promise.resolve();

      const agentUpdated = emittedEvents.filter((e) => e.name === 'spaceAgent.updated');
      expect(agentUpdated).toHaveLength(1);
      expect((agentUpdated[0].data as { agent: { name: string } }).agent.name).toBe('Coder');
    });

    it('does not emit event for skipped agent', async () => {
      agentRepo.create({ spaceId: SPACE_ID, name: 'Coder' });
      const bundle = makeBundle([{ name: 'Coder', role: 'coder' }], []);

      await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
        spaceId: SPACE_ID,
        bundle,
        conflictResolution: { agents: { Coder: 'skip' } },
      });

      await Promise.resolve();

      const agentEvents = emittedEvents.filter((e) => e.name.startsWith('spaceAgent'));
      expect(agentEvents).toHaveLength(0);
    });

    it('emits spaceWorkflow.created for each newly created workflow', async () => {
      const bundle = makeBundle(
        [{ name: 'Coder', role: 'coder' }],
        [{ name: 'Pipe', nodes: [{ agentRef: 'Coder', name: 's1' }] }]
      );

      await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
        spaceId: SPACE_ID,
        bundle,
      });

      await Promise.resolve();

      const wfCreated = emittedEvents.filter((e) => e.name === 'spaceWorkflow.created');
      expect(wfCreated).toHaveLength(1);
      expect((wfCreated[0].data as { workflow: { name: string } }).workflow.name).toBe('Pipe');
    });

    it('emits spaceWorkflow.deleted (old id) + spaceWorkflow.created (new id) for replaced workflow', async () => {
      const existingAgent = agentRepo.create({ spaceId: SPACE_ID, name: 'Coder' });
      const existingAgentId = existingAgent.id;
      const existingWf = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'Pipe',
        nodes: [{ name: 's1', agentId: existingAgentId }],
        transitions: [],
        completionAutonomyLevel: 3,
      });
      const oldWorkflowId = existingWf.id;

      const bundle = makeBundle(
        [{ name: 'Coder', role: 'coder' }],
        [{ name: 'Pipe', nodes: [{ agentRef: 'Coder', name: 's1' }] }]
      );

      await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
        spaceId: SPACE_ID,
        bundle,
        conflictResolution: { workflows: { Pipe: 'replace' } },
      });

      await Promise.resolve();

      const deletedEvents = emittedEvents.filter((e) => e.name === 'spaceWorkflow.deleted');
      expect(deletedEvents).toHaveLength(1);
      expect((deletedEvents[0].data as { workflowId: string }).workflowId).toBe(oldWorkflowId);

      const createdEvents = emittedEvents.filter((e) => e.name === 'spaceWorkflow.created');
      expect(createdEvents).toHaveLength(1);
      const newId = (createdEvents[0].data as { workflow: { id: string } }).workflow.id;
      expect(newId).not.toBe(oldWorkflowId);
    });

    it('emits spaceAgent.created and spaceWorkflow.created for bundle with both', async () => {
      const bundle = makeBundle(
        [{ name: 'AgentA', role: 'coder' }],
        [{ name: 'WfA', nodes: [{ agentRef: 'AgentA', name: 'step' }] }]
      );

      await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
        spaceId: SPACE_ID,
        bundle,
      });

      await Promise.resolve();

      expect(emittedEvents.some((e) => e.name === 'spaceAgent.created')).toBe(true);
      expect(emittedEvents.some((e) => e.name === 'spaceWorkflow.created')).toBe(true);
    });
  });
});

describe('multi-agent step import', () => {
  let db: Database;
  let agentRepo: SpaceAgentRepository;
  let workflowRepo: SpaceWorkflowRepository;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let handlers: Map<string, RequestHandler>;
  let internalEventBus: InternalEventBus<DaemonInternalEventMap>;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    insertSpace(db, SPACE_ID, 'My Space');

    agentRepo = new SpaceAgentRepository(db as any);
    workflowRepo = new SpaceWorkflowRepository(db as any);

    const agentLookup: SpaceAgentLookup = {
      getAgentById(spaceId: string, id: string) {
        const agent = agentRepo.getById(id);
        if (!agent || agent.spaceId !== spaceId) return null;
        return { id: agent.id, name: agent.name };
      },
    };
    workflowManager = new SpaceWorkflowManager(workflowRepo, agentLookup);
    spaceManager = createMockSpaceManager(SPACE_ID);
    const mockHub = createMockHub();
    handlers = mockHub.handlers;
    const mockInternalEventBus = createMockInternalEventBus();
    internalEventBus = mockInternalEventBus.hub;

    setupSpaceExportImportHandlers(
      mockHub.hub,
      spaceManager,
      agentRepo,
      workflowRepo,
      workflowManager,
      db as any,
      internalEventBus
    );
  });

  it('imports multi-agent step and resolves each agentRef → agentId', async () => {
    const bundle = makeMultiAgentBundle(
      [
        { name: 'Coder', role: 'coder' },
        { name: 'Reviewer', role: 'reviewer' },
      ],
      [
        {
          name: 'Collab Pipeline',
          nodes: [
            {
              multiAgentStep: {
                name: 'Parallel',
                agents: [
                  { agentRef: 'Coder', name: 'coder' },
                  { agentRef: 'Reviewer', name: 'reviewer' },
                ],
              },
            },
          ],
        },
      ]
    );

    const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
      spaceId: SPACE_ID,
      bundle,
    });

    expect(result.agents).toHaveLength(2);
    const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
    const step = wf.nodes[0];

    expect(step.agents).toHaveLength(2);
    expect(step.agentId).toBeUndefined();

    const coderAgent = agentRepo.getById(result.agents.find((a) => a.name === 'Coder')!.id)!;
    const reviewerAgent = agentRepo.getById(result.agents.find((a) => a.name === 'Reviewer')!.id)!;
    const agentIds = step.agents!.map((a) => a.agentId);
    expect(agentIds).toContain(coderAgent.id);
    expect(agentIds).toContain(reviewerAgent.id);
  });

  it('preserves per-agent customPrompt in imported multi-agent step', async () => {
    const bundle = makeMultiAgentBundle(
      [
        { name: 'Coder', role: 'coder' },
        { name: 'Reviewer', role: 'reviewer' },
      ],
      [
        {
          name: 'Pipeline',
          nodes: [
            {
              multiAgentStep: {
                name: 'Parallel',
                agents: [
                  {
                    agentRef: 'Coder',
                    name: 'coder',
                    systemPrompt: { value: 'Implement the feature' },
                  },
                  {
                    agentRef: 'Reviewer',
                    name: 'reviewer',
                    systemPrompt: { value: 'Review thoroughly' },
                  },
                ],
              },
            },
          ],
        },
      ]
    );

    const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
      spaceId: SPACE_ID,
      bundle,
    });

    const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
    const agentEntries = wf.nodes[0].agents!;
    const byAgentId = new Map(agentEntries.map((a) => [a.agentId, a]));

    const coderId = result.agents.find((a) => a.name === 'Coder')!.id;
    const reviewerId = result.agents.find((a) => a.name === 'Reviewer')!.id;
    expect((byAgentId.get(coderId)?.customPrompt as any)?.value).toBe('Implement the feature');
    expect((byAgentId.get(reviewerId)?.customPrompt as any)?.value).toBe('Review thoroughly');
  });

  it('imports channels as-is in multi-agent step', async () => {
    const bundle = makeMultiAgentBundle(
      [
        { name: 'Coder', role: 'coder' },
        { name: 'Reviewer', role: 'reviewer' },
      ],
      [
        {
          name: 'Pipeline',
          nodes: [
            {
              multiAgentStep: {
                name: 'Parallel',
                agents: [
                  { agentRef: 'Coder', name: 'coder' },
                  { agentRef: 'Reviewer', name: 'reviewer' },
                ],
                channels: [{ from: 'coder', to: 'reviewer', label: 'feedback' }],
              },
            },
          ],
        },
      ]
    );

    const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
      spaceId: SPACE_ID,
      bundle,
    });

    const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
    expect(wf.channels).toHaveLength(1);
    expect(wf.channels![0].from).toBe('coder');
    expect(wf.channels![0].to).toBe('reviewer');
    expect(wf.channels![0].label).toBe('feedback');
  });

  it('throws when multi-agent step has unresolved agent ref', async () => {
    const bundle = makeMultiAgentBundle(
      [{ name: 'Coder', role: 'coder' }],
      [
        {
          name: 'Pipeline',
          nodes: [
            {
              multiAgentStep: {
                name: 'Parallel',
                agents: [
                  { agentRef: 'Coder', name: 'coder' },
                  { agentRef: 'GhostAgent', name: 'ghost' },
                ],
              },
            },
          ],
        },
      ]
    );

    await expect(
      call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle })
    ).rejects.toThrow('unresolved agent reference');
  });

  it('preview: flags unresolved agent ref in multi-agent step', async () => {
    const bundle = makeMultiAgentBundle(
      [{ name: 'Coder', role: 'coder' }],
      [
        {
          name: 'Pipeline',
          nodes: [
            {
              multiAgentStep: {
                name: 'Parallel',
                agents: [
                  { agentRef: 'Coder', name: 'coder' },
                  { agentRef: 'Missing', name: 'missing' },
                ],
              },
            },
          ],
        },
      ]
    );

    const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
      spaceId: SPACE_ID,
      bundle,
    });

    expect(result.validationErrors.some((e) => e.includes('Missing'))).toBe(true);
  });

  it('single agent step imports with agents array containing one entry', async () => {
    const bundle = makeSingleAgentBundle('Coder', 'coder', 'Legacy Step');

    const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
      spaceId: SPACE_ID,
      bundle,
    });

    const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
    const step = wf.nodes[0];
    const coderId = result.agents[0].id;
    expect(step.agents).toHaveLength(1);
    expect(step.agents![0].agentId).toBe(coderId);
  });

  it('preview: wildcard channel role is always valid', async () => {
    const bundle = makeMultiAgentBundle(
      [{ name: 'Coder', role: 'coder' }],
      [
        {
          name: 'Pipeline',
          nodes: [
            {
              multiAgentStep: {
                name: 'Solo',
                agents: [{ agentRef: 'Coder', name: 'coder' }],
              },
            },
          ],
        },
      ]
    );

    const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
      spaceId: SPACE_ID,
      bundle,
    });

    expect(result.validationErrors.filter((e) => e.includes('channel'))).toHaveLength(0);
  });

  it('resolves multi-agent step refs from existing space agents', async () => {
    const existing1 = agentRepo.create({ spaceId: SPACE_ID, name: 'LocalCoder' });
    const existing2 = agentRepo.create({
      spaceId: SPACE_ID,
      name: 'LocalReviewer',
      role: 'reviewer',
    });

    const bundle = makeMultiAgentBundle(
      [],
      [
        {
          name: 'Pipeline',
          nodes: [
            {
              multiAgentStep: {
                name: 'Parallel',
                agents: [
                  { agentRef: 'LocalCoder', name: 'coder' },
                  { agentRef: 'LocalReviewer', name: 'reviewer' },
                ],
              },
            },
          ],
        },
      ]
    );

    const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
      spaceId: SPACE_ID,
      bundle,
    });

    const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
    const agentIds = wf.nodes[0].agents!.map((a) => a.agentId);
    expect(agentIds).toContain(existing1.id);
    expect(agentIds).toContain(existing2.id);
  });
});

type BundleAgent = {
  name: string;
  handle?: string;
  customPrompt?: string;
  model?: string;
  thinkingLevel?: 'auto' | 'off' | 'think8k' | 'think16k' | 'think24k' | 'think32k';
  role?: string;
};
type BundleWorkflow = {
  name: string;
  nodes: Array<{
    agentRef: string;
    name: string;
    eventInterests?: Array<{ topic: string; label?: string }>;
  }>;
};

function makeBundle(agents: BundleAgent[], workflows: BundleWorkflow[]): object {
  return {
    version: 1,
    type: 'bundle',
    name: 'Test Bundle',
    agents: agents.map((a) => ({
      version: 1,
      type: 'agent',
      name: a.name,
      ...(a.handle ? { handle: a.handle } : {}),
      ...(a.customPrompt ? { systemPrompt: a.customPrompt } : {}),
      ...(a.model ? { model: a.model } : {}),
      ...(a.thinkingLevel ? { thinkingLevel: a.thinkingLevel } : {}),
    })),
    workflows: workflows.map((w) => ({
      version: 1,
      type: 'workflow',
      name: w.name,
      nodes: w.nodes.map((s) => ({
        agents: [
          {
            agentRef: s.agentRef,
            name: s.agentRef,
            ...(s.eventInterests ? { eventInterests: s.eventInterests } : {}),
          },
        ],
        name: s.name,
      })),
      startNode: w.nodes[0]?.name ?? '',
      tags: [],
    })),
    exportedAt: Date.now(),
  };
}

function makeBundleWithCondition(type: string, expression: string | undefined): object {
  void type;
  void expression;
  return {
    version: 1,
    type: 'bundle',
    name: 'Condition Bundle',
    agents: [{ version: 1, type: 'agent', name: 'A' }],
    workflows: [
      {
        version: 1,
        type: 'workflow',
        name: 'ConditionWF',
        nodes: [
          { agents: [{ agentRef: 'A', name: 'A' }], name: 'S1' },
          { agents: [{ agentRef: 'A', name: 'A' }], name: 'S2' },
        ],
        startNode: 'S1',
        tags: [],
      },
    ],
    exportedAt: Date.now(),
  };
}

function makeBundleWithRules(): object {
  return {
    version: 1,
    type: 'bundle',
    name: 'Rules Bundle',
    agents: [{ version: 1, type: 'agent', name: 'Coder' }],
    workflows: [
      {
        version: 1,
        type: 'workflow',
        name: 'RulesWF',
        nodes: [{ agents: [{ agentRef: 'Coder', name: 'Coder' }], name: 'Code' }],
        startNode: 'Code',
        tags: [],
      },
    ],
    exportedAt: Date.now(),
  };
}

function makeTwoStepBundle(): object {
  return {
    version: 1,
    type: 'bundle',
    name: 'Two Step Bundle',
    agents: [
      { version: 1, type: 'agent', name: 'Coder' },
      { version: 1, type: 'agent', name: 'Reviewer' },
    ],
    workflows: [
      {
        version: 1,
        type: 'workflow',
        name: 'CodingPipeline',
        nodes: [
          { agents: [{ agentRef: 'Coder', name: 'Coder' }], name: 'Code' },
          { agents: [{ agentRef: 'Reviewer', name: 'Reviewer' }], name: 'Review' },
        ],
        startNode: 'Code',
        tags: [],
      },
    ],
    exportedAt: Date.now(),
  };
}

type AgentPromptOverride = { value: string };

type MultiAgentStepEntry =
  | { agentRef: string; name: string; systemPrompt?: string | AgentPromptOverride }
  | {
      multiAgentStep: {
        name: string;
        agents: Array<{
          agentRef: string;
          name: string;
          systemPrompt?: string | AgentPromptOverride;
        }>;
        channels?: Array<{
          from: string;
          to: string | string[];
          label?: string;
        }>;
        instructions?: string;
      };
    };

const SYNTHETIC_END_NODE_NAME = '__synthetic_end__';

function makeMultiAgentBundle(
  agents: BundleAgent[],
  workflows: Array<{
    name: string;
    nodes: MultiAgentStepEntry[];
  }>
): object {
  return {
    version: 1,
    type: 'bundle',
    name: 'Multi-Agent Bundle',
    agents: agents.map((a) => ({
      version: 1,
      type: 'agent',
      name: a.name,
    })),
    workflows: workflows.map((w) => {
      const workflowChannels: Array<{
        from: string;
        to: string | string[];
        label?: string;
      }> = [];
      const nodes = w.nodes.map((s) => {
        if ('multiAgentStep' in s) {
          const ms = s.multiAgentStep;
          if (ms.channels) {
            workflowChannels.push(...ms.channels);
          }
          const step: Record<string, unknown> = {
            name: ms.name,
            agents: ms.agents,
          };
          if (ms.instructions) step.instructions = ms.instructions;
          return step;
        }
        return {
          agents: [{ agentRef: s.agentRef, name: s.agentRef }],
          name: s.name,
          ...(s.systemPrompt ? { systemPrompt: s.systemPrompt } : {}),
        };
      });

      const lastSrc = w.nodes[w.nodes.length - 1];
      if (lastSrc) {
        const endAgentRef =
          'multiAgentStep' in lastSrc
            ? lastSrc.multiAgentStep.agents[0]?.agentRef
            : lastSrc.agentRef;
        if (endAgentRef) {
          nodes.push({
            name: SYNTHETIC_END_NODE_NAME,
            agents: [{ agentRef: endAgentRef, name: 'end' }],
          });
        }
      }

      return {
        version: 1,
        type: 'workflow',
        name: w.name,
        nodes,
        ...(workflowChannels.length > 0 ? { channels: workflowChannels } : {}),
        startNode: w.nodes[0]
          ? 'multiAgentStep' in w.nodes[0]
            ? w.nodes[0].multiAgentStep.name
            : w.nodes[0].name
          : '',
        tags: [],
      };
    }),
    exportedAt: Date.now(),
  };
}

function makeSingleAgentBundle(agentName: string, _agentRole: string, stepName: string): object {
  return {
    version: 1,
    type: 'bundle',
    name: 'Single Agent Bundle',
    agents: [{ version: 1, type: 'agent', name: agentName }],
    workflows: [
      {
        version: 1,
        type: 'workflow',
        name: 'Legacy Workflow',
        nodes: [{ agents: [{ agentRef: agentName, name: agentName }], name: stepName }],
        startNode: stepName,
        tags: [],
      },
    ],
    exportedAt: Date.now(),
  };
}

describe('full export→import round-trip', () => {
  let db: Database;
  let agentRepo: SpaceAgentRepository;
  let workflowRepo: SpaceWorkflowRepository;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let handlers: Map<string, RequestHandler>;
  let internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  let emittedEvents: Array<{ name: string; data: unknown }>;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    insertSpace(db, SPACE_ID, 'Round Trip Space');

    agentRepo = new SpaceAgentRepository(db as any);
    workflowRepo = new SpaceWorkflowRepository(db as any);

    const agentLookup: SpaceAgentLookup = {
      getAgentById(spaceId: string, id: string) {
        const agent = agentRepo.getById(id);
        if (!agent || agent.spaceId !== spaceId) return null;
        return { id: agent.id, name: agent.name };
      },
    };
    workflowManager = new SpaceWorkflowManager(workflowRepo, agentLookup);
    spaceManager = createMockSpaceManager(SPACE_ID);

    const mockHub = createMockHub();
    handlers = mockHub.handlers;
    const mockInternalEventBus = createMockInternalEventBus();
    internalEventBus = mockInternalEventBus.hub;
    emittedEvents = mockInternalEventBus.emittedEvents;

    setupSpaceExportImportHandlers(
      mockHub.hub,
      spaceManager,
      agentRepo,
      workflowRepo,
      workflowManager,
      db as any,
      internalEventBus
    );
  });

  it('single-agent workflow round-trip: export → import produces equivalent workflow', async () => {
    const coderAgent: SpaceWorkerAgent = {
      id: 'src-agent-1',
      spaceId: 'other-space',
      name: 'My Coder',
      customPrompt: 'You write code.',
      tools: ['bash', 'read_file'],
      createdAt: 1000,
      updatedAt: 2000,
    };
    const workflow: SpaceWorkflow = {
      id: 'src-wf-1',
      spaceId: 'other-space',
      name: 'Code Pipeline',
      description: 'A simple coder workflow',
      nodes: [
        {
          id: 'src-step-1',
          name: 'Code',
          agents: [{ agentId: 'src-agent-1', name: 'coder' }],
        },
      ],
      startNodeId: 'src-step-1',
      tags: ['coding'],
      createdAt: 1000,
      updatedAt: 2000,
    };

    const bundle = exportBundle([coderAgent], [workflow], 'Test Export');

    const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
      spaceId: SPACE_ID,
      bundle,
    });

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe('My Coder');
    expect(result.agents[0].action).toBe('created');

    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].name).toBe('Code Pipeline');
    expect(result.workflows[0].action).toBe('created');

    const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
    expect(importedWf.name).toBe('Code Pipeline');
    expect(importedWf.description).toBe('A simple coder workflow');
    expect(importedWf.tags).toEqual(['coding']);

    const importedAgent = agentRepo.getById(result.agents[0].id)!;
    expect(importedAgent.name).toBe('My Coder');
    expect(importedAgent.customPrompt).toBe('You write code.');
    expect(importedAgent.tools).toEqual(['bash', 'read_file']);

    const step = importedWf.nodes[0];
    expect(step.name).toBe('Code');
    expect(step.agents![0].agentId).toBe(importedAgent.id);
    expect(step.agents![0].agentId).not.toBe('src-agent-1');

    const agentCreatedEvents = emittedEvents.filter((e) => e.name === 'spaceAgent.created');
    const wfCreatedEvents = emittedEvents.filter((e) => e.name === 'spaceWorkflow.created');
    expect(agentCreatedEvents).toHaveLength(1);
    expect(wfCreatedEvents).toHaveLength(1);
    expect((agentCreatedEvents[0].data as any).agent.name).toBe('My Coder');
    expect((wfCreatedEvents[0].data as any).workflow.name).toBe('Code Pipeline');
  });

  it('multi-agent step round-trip: export → import preserves agents array, channels, and hooks', async () => {
    const coderAgent: SpaceWorkerAgent = {
      id: 'src-coder',
      spaceId: 'other-space',
      name: 'Senior Coder',
      customPrompt: null,
      createdAt: 1000,
      updatedAt: 2000,
    };
    const reviewerAgent: SpaceWorkerAgent = {
      id: 'src-reviewer',
      spaceId: 'other-space',
      name: 'Code Reviewer',
      customPrompt: null,
      createdAt: 1000,
      updatedAt: 2000,
    };

    const workflow: SpaceWorkflow = {
      id: 'src-wf-ma',
      spaceId: 'other-space',
      name: 'Collab Workflow',
      nodes: [
        {
          id: 'step-ma',
          name: 'Code and Review',
          agents: [
            {
              agentId: 'src-coder',
              name: 'coder',
              customPrompt: { value: 'Implement the feature' },
            },
            {
              agentId: 'src-reviewer',
              name: 'reviewer',
              customPrompt: { value: 'Review thoroughly' },
            },
          ],
        },
        {
          id: 'step-end',
          name: 'End',
          agents: [{ agentId: 'src-coder', name: 'end' }],
        },
      ],
      channels: [{ id: 'ch-1', from: 'coder', to: 'reviewer', label: 'hand-off' }],
      hooks: [
        {
          id: 'hook-1',
          enabled: true,
          sourceNode: 'Code and Review',
          targetNode: 'End',
          method: 'send_message',
          validator: { kind: 'script', interpreter: 'bash', source: 'echo \'{"type":"allow"}\'' },
          authorizedCallers: [{ sourceNode: 'Code and Review', agentSlots: ['coder'] }],
        },
      ],
      startNodeId: 'step-ma',
      tags: ['collab'],
      createdAt: 1000,
      updatedAt: 2000,
    };

    const bundle = exportBundle([coderAgent, reviewerAgent], [workflow], 'MA Export');
    const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
      spaceId: SPACE_ID,
      bundle,
    });

    expect(result.agents).toHaveLength(2);
    expect(result.workflows).toHaveLength(1);

    const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
    const importedStep = importedWf.nodes[0];

    expect(importedStep.agents).toHaveLength(2);

    const coderImported = agentRepo.getById(
      result.agents.find((a) => a.name === 'Senior Coder')!.id
    )!;
    const reviewerImported = agentRepo.getById(
      result.agents.find((a) => a.name === 'Code Reviewer')!.id
    )!;
    const importedAgentIds = importedStep.agents!.map((a) => a.agentId);
    expect(importedAgentIds).toContain(coderImported.id);
    expect(importedAgentIds).toContain(reviewerImported.id);
    expect(importedAgentIds).not.toContain('src-coder');
    expect(importedAgentIds).not.toContain('src-reviewer');

    const coderEntry = importedStep.agents!.find((a) => a.agentId === coderImported.id)!;
    const reviewerEntry = importedStep.agents!.find((a) => a.agentId === reviewerImported.id)!;
    expect((coderEntry.customPrompt as any)?.value).toBe('Implement the feature');
    expect(coderEntry.name).toBe('coder');
    expect((reviewerEntry.customPrompt as any)?.value).toBe('Review thoroughly');
    expect(reviewerEntry.name).toBe('reviewer');

    expect(importedWf.channels).toHaveLength(1);
    expect(importedWf.channels![0].from).toBe('coder');
    expect(importedWf.channels![0].to).toBe('reviewer');
    expect(importedWf.channels![0].label).toBe('hand-off');

    expect(importedWf.hooks).toEqual(workflow.hooks);
  });

  it('import rejects bundle with empty name in agents[] entry (Zod validation)', async () => {
    const bundle = {
      version: 1,
      name: 'Bad Bundle',
      agents: [{ version: 1, type: 'agent', name: 'Coder', role: 'coder' }],
      workflows: [
        {
          name: 'Bad Workflow',
          nodes: [
            {
              name: 'Bad Node',
              agents: [{ agentRef: 'Coder', name: '' }],
            },
          ],
          transitions: [],
          rules: [],
          tags: [],
        },
      ],
    };
    await expect(
      call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle })
    ).rejects.toThrow();
  });

  it('import rejects bundle with missing name in agents[] entry (Zod validation)', async () => {
    const bundle = {
      version: 1,
      name: 'Bad Bundle',
      agents: [{ version: 1, type: 'agent', name: 'Coder', role: 'coder' }],
      workflows: [
        {
          name: 'Bad Workflow',
          nodes: [
            {
              name: 'Bad Node',
              // @ts-expect-error intentionally omitting required name
              agents: [{ agentRef: 'Coder' }],
            },
          ],
          transitions: [],
          rules: [],
          tags: [],
        },
      ],
    };
    await expect(
      call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle })
    ).rejects.toThrow();
  });

  it('channel topology round-trip: one-way channel preserved', async () => {
    const agentA: SpaceWorkerAgent = {
      id: 'src-a',
      spaceId: 'other-space',
      name: 'Agent Alpha',
      role: 'alpha',
      createdAt: 1000,
      updatedAt: 2000,
    };
    const agentB: SpaceWorkerAgent = {
      id: 'src-b',
      spaceId: 'other-space',
      name: 'Agent Beta',
      role: 'beta',
      createdAt: 1000,
      updatedAt: 2000,
    };

    const workflow: SpaceWorkflow = {
      id: 'src-wf-ow',
      spaceId: 'other-space',
      name: 'One-Way Workflow',
      nodes: [
        {
          id: 'step-ow',
          name: 'Directed',
          agents: [
            { agentId: 'src-a', name: 'alpha' },
            { agentId: 'src-b', name: 'beta' },
          ],
        },
        {
          id: 'step-end',
          name: 'End',
          agents: [{ agentId: 'src-a', name: 'end' }],
        },
      ],
      transitions: [],
      startNodeId: 'step-ow',
      rules: [],
      tags: [],
      channels: [{ id: 'ch-1', from: 'alpha', to: 'beta', label: 'handoff' }],
      createdAt: 1000,
      updatedAt: 2000,
    };

    const bundle = exportBundle([agentA, agentB], [workflow], 'One-Way Export');
    const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
      spaceId: SPACE_ID,
      bundle,
    });

    const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
    const ch = importedWf.channels![0];
    expect(ch.from).toBe('alpha');
    expect(ch.to).toBe('beta');
  });

  it('channel topology round-trip: fan-out (array `to`) preserved', async () => {
    const hub: SpaceWorkerAgent = {
      id: 'src-hub',
      spaceId: 'other-space',
      name: 'Hub Agent',
      role: 'hub',
      createdAt: 1000,
      updatedAt: 2000,
    };
    const spoke1: SpaceWorkerAgent = {
      id: 'src-spoke1',
      spaceId: 'other-space',
      name: 'Spoke One',
      role: 'spoke1',
      createdAt: 1000,
      updatedAt: 2000,
    };
    const spoke2: SpaceWorkerAgent = {
      id: 'src-spoke2',
      spaceId: 'other-space',
      name: 'Spoke Two',
      role: 'spoke2',
      createdAt: 1000,
      updatedAt: 2000,
    };

    const workflow: SpaceWorkflow = {
      id: 'src-wf-fanout',
      spaceId: 'other-space',
      name: 'Fan-Out Workflow',
      nodes: [
        {
          id: 'step-fo',
          name: 'Fan Out',
          agents: [
            { agentId: 'src-hub', name: 'hub' },
            { agentId: 'src-spoke1', name: 'spoke1' },
            { agentId: 'src-spoke2', name: 'spoke2' },
          ],
        },
        {
          id: 'step-end',
          name: 'End',
          agents: [{ agentId: 'src-hub', name: 'end' }],
        },
      ],
      transitions: [],
      startNodeId: 'step-fo',
      rules: [],
      tags: [],
      channels: [{ id: 'ch-1', from: 'hub', to: ['spoke1', 'spoke2'] }],
      createdAt: 1000,
      updatedAt: 2000,
    };

    const bundle = exportBundle([hub, spoke1, spoke2], [workflow], 'Fan-Out Export');
    const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
      spaceId: SPACE_ID,
      bundle,
    });

    const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
    const ch = importedWf.channels![0];
    expect(ch.from).toBe('hub');
    expect(ch.to).toEqual(['spoke1', 'spoke2']);
  });

  it('channel topology round-trip: wildcard (*) preserved', async () => {
    const a: SpaceWorkerAgent = {
      id: 'src-wa',
      spaceId: 'other-space',
      name: 'Wild Agent',
      role: 'wild',
      createdAt: 1000,
      updatedAt: 2000,
    };

    const workflow: SpaceWorkflow = {
      id: 'src-wf-wc',
      spaceId: 'other-space',
      name: 'Wildcard Workflow',
      nodes: [
        {
          id: 'step-wc',
          name: 'Broadcast',
          agents: [{ agentId: 'src-wa', name: 'wild' }],
        },
      ],
      transitions: [],
      startNodeId: 'step-wc',
      rules: [],
      tags: [],
      channels: [{ id: 'ch-1', from: '*', to: '*' }],
      createdAt: 1000,
      updatedAt: 2000,
    };

    const bundle = exportBundle([a], [workflow], 'Wildcard Export');
    const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
      spaceId: SPACE_ID,
      bundle,
    });

    const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
    const ch = importedWf.channels![0];
    expect(ch.from).toBe('*');
    expect(ch.to).toBe('*');
  });

  it('mixed single/multi-agent workflow round-trip preserves both step types', async () => {
    const plannerAgent: SpaceWorkerAgent = {
      id: 'src-planner',
      spaceId: 'other-space',
      name: 'Planner',
      customPrompt: null,
      createdAt: 1000,
      updatedAt: 2000,
    };
    const coderAgent2: SpaceWorkerAgent = {
      id: 'src-coder2',
      spaceId: 'other-space',
      name: 'Coder2',
      customPrompt: null,
      createdAt: 1000,
      updatedAt: 2000,
    };
    const reviewAgent: SpaceWorkerAgent = {
      id: 'src-review',
      spaceId: 'other-space',
      name: 'Reviewer2',
      customPrompt: null,
      createdAt: 1000,
      updatedAt: 2000,
    };

    const workflow: SpaceWorkflow = {
      id: 'src-wf-mix',
      spaceId: 'other-space',
      name: 'Mixed Workflow',
      nodes: [
        {
          id: 'step-plan',
          name: 'Plan',
          agents: [{ agentId: 'src-planner', name: 'planner' }],
        },
        {
          id: 'step-collab',
          name: 'Implement and Review',
          agents: [
            { agentId: 'src-coder2', name: 'coder' },
            { agentId: 'src-review', name: 'reviewer' },
          ],
        },
        {
          id: 'step-end',
          name: 'End',
          agents: [{ agentId: 'src-coder2', name: 'end' }],
        },
      ],
      channels: [{ id: 'ch-1', from: 'planner', to: 'coder' }],
      startNodeId: 'step-plan',
      tags: ['mixed'],
      createdAt: 1000,
      updatedAt: 2000,
    };

    const bundle = exportBundle(
      [plannerAgent, coderAgent2, reviewAgent],
      [workflow],
      'Mixed Export'
    );
    const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
      spaceId: SPACE_ID,
      bundle,
    });

    const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
    expect(importedWf.nodes).toHaveLength(3);

    const planStep = importedWf.nodes.find((s) => s.name === 'Plan')!;
    expect(planStep.agents).toHaveLength(1);

    const collabStep = importedWf.nodes.find((s) => s.name === 'Implement and Review')!;
    expect(collabStep.agents).toHaveLength(2);
    expect(importedWf.channels).toHaveLength(1);

    expect(importedWf.startNodeId).toBe(planStep.id);

    expect(importedWf.tags).toEqual(['mixed']);
  });

  it('single-agent workflow export → import via exportBundle', async () => {
    const agentSrc: SpaceWorkerAgent = {
      id: 'src-legacy',
      spaceId: 'other-space',
      name: 'Legacy Coder',
      customPrompt: null,
      createdAt: 1000,
      updatedAt: 2000,
    };
    const wfSrc: SpaceWorkflow = {
      id: 'src-wf-legacy',
      spaceId: 'other-space',
      name: 'Legacy Workflow',
      nodes: [{ id: 'step-l', name: 'Code', agents: [{ agentId: 'src-legacy', name: 'coder' }] }],
      startNodeId: 'step-l',
      tags: [],
      createdAt: 1000,
      updatedAt: 2000,
    };

    const bundle = exportBundle([agentSrc], [wfSrc], 'Legacy Export');
    const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
      spaceId: SPACE_ID,
      bundle,
    });

    const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
    const step = importedWf.nodes[0];
    expect(step.agents).toHaveLength(1);
    const importedAgentId = result.agents[0].id;
    expect(step.agents![0].agentId).toBe(importedAgentId);
  });

  it('disabled workflow export → import round-trip preserves disabled flag', async () => {
    const agentSrc: SpaceWorkerAgent = {
      id: 'src-dis',
      spaceId: 'other-space',
      name: 'Dis Agent',
      customPrompt: null,
      createdAt: 1000,
      updatedAt: 2000,
    };
    const wfSrc: SpaceWorkflow = {
      id: 'src-wf-dis',
      spaceId: 'other-space',
      name: 'Disabled Workflow',
      nodes: [{ id: 'step-d', name: 'Code', agents: [{ agentId: 'src-dis', name: 'coder' }] }],
      startNodeId: 'step-d',
      tags: [],
      disabled: true,
      createdAt: 1000,
      updatedAt: 2000,
    };

    const bundle = exportBundle([agentSrc], [wfSrc], 'Disabled Export');
    const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
      spaceId: SPACE_ID,
      bundle,
    });

    const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
    expect(importedWf.disabled).toBe(true);
  });

  it('error: import with unknown agentRef in multi-agent step throws and rolls back', async () => {
    const agentSrc: SpaceWorkerAgent = {
      id: 'src-known',
      spaceId: 'other-space',
      name: 'Known Agent',
      customPrompt: null,
      createdAt: 1000,
      updatedAt: 2000,
    };
    const wfSrc: SpaceWorkflow = {
      id: 'src-wf-err',
      spaceId: 'other-space',
      name: 'Bad Workflow',
      nodes: [
        {
          id: 'step-bad',
          name: 'Parallel',
          agents: [
            { agentId: 'src-known', name: 'coder' },
            { agentId: 'src-ghost', name: 'ghost' },
          ],
        },
      ],
      startNodeId: 'step-bad',
      tags: [],
      createdAt: 1000,
      updatedAt: 2000,
    };

    const bundle = exportBundle([agentSrc], [wfSrc], 'Bad Export');

    await expect(
      call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle })
    ).rejects.toThrow('unresolved agent reference');

    expect(agentRepo.getBySpaceId(SPACE_ID)).toHaveLength(0);
    expect(workflowRepo.listWorkflows(SPACE_ID)).toHaveLength(0);
  });

  it('surfaces a warning when imported workflow handle conflicts with an existing space handle', async () => {
    const existingAgent = agentRepo.create({
      spaceId: SPACE_ID,
      name: 'Existing Coder',
      customPrompt: null,
      tools: null,
      settingSources: null,
    });
    const existing = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Old Workflow',
      nodes: [{ id: 'n1', name: 'Work', agentId: existingAgent.id }],
      startNodeId: 'n1',
      completionAutonomyLevel: 3,
    });
    db.prepare(`UPDATE space_workflows SET handle = 'taken-handle' WHERE id = ?`).run(existing.id);

    const bundleAgent: SpaceWorkerAgent = {
      id: 'bundle-agent',
      spaceId: 'src-space',
      name: 'Existing Coder',
      customPrompt: null,
      tools: [],
      createdAt: 0,
      updatedAt: 0,
    };
    const bundleWorkflow: SpaceWorkflow = {
      id: 'bundle-wf',
      spaceId: 'src-space',
      name: 'New Workflow',
      handle: 'taken-handle',
      nodes: [{ id: 'n2', name: 'Work', agents: [{ agentId: 'bundle-agent', name: 'coder' }] }],
      startNodeId: 'n2',
      tags: [],
      completionAutonomyLevel: 3,
      createdAt: 0,
      updatedAt: 0,
    };
    const bundle = exportBundle([bundleAgent], [bundleWorkflow], 'Conflict Bundle');

    const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
      spaceId: SPACE_ID,
      bundle,
    });

    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].name).toBe('New Workflow');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes('taken-handle'))).toBe(true);
    expect(result.warnings.some((w) => /already exists/i.test(w))).toBe(true);

    const imported = workflowRepo.getWorkflow(result.workflows[0].id);
    expect(imported?.handle).not.toBe('taken-handle');
  });
});
