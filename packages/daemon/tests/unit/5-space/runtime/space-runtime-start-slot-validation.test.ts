import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { WorkflowNodeAgent } from '@hyperneo/shared';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import {
  isMissingWorkflowAgentError,
  MissingWorkflowAgentError,
} from '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SpaceAgentTemplateRepository } from '../../../../src/storage/repositories/space-agent-template-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-start-slot-1';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, max_concurrent_tasks, created_at, updated_at)
     VALUES (?, '/tmp/workspace', ?, '', '', '', '[]', '[]', ?, 'active', 1, ?, ?)`
  ).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

describe('SpaceRuntime startWorkflowRun start-slot template audit', () => {
  let db: BunDatabase;
  let workflowManager: SpaceWorkflowManager;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let templateRepo: SpaceAgentTemplateRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let runtime: SpaceRuntime;

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID);

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    templateRepo = new SpaceAgentTemplateRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);

    workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db), null, templateRepo);

    const config: SpaceRuntimeConfig = {
      db,
      spaceManager: new SpaceManager(db),
      longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
      templateRepo,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo: new SpaceTaskRepository(db),
      nodeExecutionRepo,
    };
    runtime = new SpaceRuntime(config);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  function makeWorkflow(agents: WorkflowNodeAgent[]): string {
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Start Audit Flow',
      nodes: [
        {
          id: 'start',
          name: 'Start',
          agents,
        },
        {
          id: 'end',
          name: 'End',
          agents: [{ agentId: '', templateKey: 'worker.swe', name: 'finisher' }],
        },
      ],
      startNodeId: 'start',
      endNodeId: 'end',
      tags: [],
    });
    return workflow.id;
  }

  test('refuses to start a run whose start node binds an empty-instruction template', async () => {
    templateRepo.create({
      key: 'migrated.agent.agent-orphan',
      handle: 'orphan',
      displayName: 'Orphan',
      description: '',
      instructions: '',
      suggestedAutonomyLevel: 2,
      labels: [],
    });
    const workflowId = makeWorkflow([
      { agentId: '', templateKey: 'migrated.agent.agent-orphan', name: 'orphan-slot' },
    ]);

    let caught: unknown;
    try {
      await runtime.startWorkflowRun(SPACE_ID, workflowId, 'Orphan start');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MissingWorkflowAgentError);
    expect(isMissingWorkflowAgentError(caught)).toBe(true);
    const message = (caught as MissingWorkflowAgentError).message;
    expect(message).toContain('migrated.agent.agent-orphan');
    expect(message).toContain('empty instructions');
    expect(message).toContain('orphan-slot');
    expect(message).toContain('Start Audit Flow');
    const executionCount = db.prepare('SELECT COUNT(*) AS count FROM node_executions').get() as {
      count: number;
    };
    expect(executionCount.count).toBe(0);
  });

  test('starts normally when the slot customPrompt supplies the effective prompt', async () => {
    templateRepo.create({
      key: 'migrated.agent.agent-orphan',
      handle: 'orphan',
      displayName: 'Orphan',
      description: '',
      instructions: '',
      suggestedAutonomyLevel: 2,
      labels: [],
    });
    const workflowId = makeWorkflow([
      {
        agentId: '',
        templateKey: 'migrated.agent.agent-orphan',
        name: 'orphan-slot',
        customPrompt: { value: 'You carry the start-node role.' },
      },
    ]);

    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflowId, 'Prompted start');

    const executions = nodeExecutionRepo.listByWorkflowRun(run.id);
    expect(executions.map((execution) => execution.agentName)).toContain('orphan-slot');
  });

  test('starts normally when the start template carries real instructions', async () => {
    templateRepo.create({
      key: 'worker.gatekeeper',
      handle: 'gatekeeper',
      displayName: 'Gatekeeper',
      description: '',
      instructions: 'You gate every start.',
      suggestedAutonomyLevel: 2,
      labels: [],
    });
    const workflowId = makeWorkflow([
      { agentId: '', templateKey: 'worker.gatekeeper', name: 'gate' },
    ]);

    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflowId, 'Healthy start');

    const executions = nodeExecutionRepo.listByWorkflowRun(run.id);
    expect(executions.map((execution) => execution.agentName)).toContain('gate');
  });
});
