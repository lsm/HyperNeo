import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpaceWorkflow } from '@hyperneo/shared';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
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

const SPACE_ID = 'space-snapshot-1';

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

describe('SpaceRuntime startWorkflowRun template snapshot pinning', () => {
  let db: BunDatabase;
  let workflowManager: SpaceWorkflowManager;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let templateRepo: SpaceAgentTemplateRepository;
  let runtime: SpaceRuntime;

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID);

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    templateRepo = new SpaceAgentTemplateRepository(db);

    workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db), null, templateRepo);

    const config: SpaceRuntimeConfig = {
      db,
      spaceManager: new SpaceManager(db),
      longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
      templateRepo,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo: new SpaceTaskRepository(db),
      nodeExecutionRepo: new NodeExecutionRepository(db),
    };
    runtime = new SpaceRuntime(config);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  function pinnedPayload(runId: string): SpaceWorkflow {
    const run = workflowRunRepo.getRun(runId)!;
    expect(run.definitionVersion).toBeTruthy();
    const row = db
      .prepare(
        `SELECT payload FROM space_workflow_definition_versions
         WHERE workflow_id = ? AND version_hash = ?`
      )
      .get(run.workflowId, run.definitionVersion) as { payload: string };
    return JSON.parse(row.payload) as SpaceWorkflow;
  }

  test('pins resolved template snapshots into the run definition version', async () => {
    templateRepo.create(SPACE_ID, {
      key: 'worker.custom',
      handle: 'custom-worker',
      displayName: 'Custom Worker',
      description: 'A custom worker template.',
      instructions: 'Frozen instructions.',
      suggestedAutonomyLevel: 2,
      tools: ['Read'],
      labels: ['workflow-worker'],
    });
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Snapshot workflow',
      nodes: [
        {
          id: 'build',
          name: 'Build',
          agents: [{ agentId: '', templateKey: 'worker.custom', name: 'Worker' }],
        },
      ],
      startNodeId: 'build',
      endNodeId: 'build',
      tags: [],
    });

    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Snapshot run');

    const pinned = pinnedPayload(run.id);
    expect(pinned.templateSnapshots?.['worker.custom'].instructions).toBe('Frozen instructions.');
    expect(pinned.templateSnapshots?.['worker.custom'].tools).toEqual(['Read']);

    const live = workflowManager.getWorkflow(workflow.id)!;
    expect(live.templateSnapshots).toBeUndefined();

    const rehydrated = workflowManager.getWorkflowForRun(workflowRunRepo.getRun(run.id)!)!;
    expect(rehydrated.templateSnapshots?.['worker.custom'].instructions).toBe(
      'Frozen instructions.'
    );
  });

  test('prefers built-in templates over stored templates with colliding keys', async () => {
    templateRepo.create(SPACE_ID, {
      key: 'worker.swe',
      handle: 'swe',
      displayName: 'Stored SWE',
      description: 'Stored collision.',
      instructions: 'Stored instructions.',
      suggestedAutonomyLevel: 1,
      labels: [],
    });
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Collision workflow',
      nodes: [
        {
          id: 'build',
          name: 'Build',
          agents: [{ agentId: '', templateKey: 'worker.swe', name: 'SWE' }],
        },
      ],
      startNodeId: 'build',
      endNodeId: 'build',
      tags: [],
    });

    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Collision run');

    const snapshot = pinnedPayload(run.id).templateSnapshots?.['worker.swe'];
    expect(snapshot?.key).toBe('worker.swe');
    expect(snapshot?.instructions).not.toBe('Stored instructions.');
  });

  test('keeps the pinned snapshot frozen across later template edits', async () => {
    templateRepo.create(SPACE_ID, {
      key: 'worker.custom',
      handle: 'custom-worker',
      displayName: 'Custom Worker',
      description: 'A custom worker template.',
      instructions: 'Frozen instructions.',
      suggestedAutonomyLevel: 2,
      labels: [],
    });
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: 'Freeze workflow',
      nodes: [
        {
          id: 'build',
          name: 'Build',
          agents: [{ agentId: '', templateKey: 'worker.custom', name: 'Worker' }],
        },
      ],
      startNodeId: 'build',
      endNodeId: 'build',
      tags: [],
    });

    const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Freeze run');

    const version = templateRepo.getOwnedWithVersion(SPACE_ID, 'worker.custom')!;
    const updated = templateRepo.casUpdate(
      SPACE_ID,
      'worker.custom',
      { instructions: 'Edited instructions.' },
      version.version
    );
    expect(updated?.instructions).toBe('Edited instructions.');

    expect(pinnedPayload(run.id).templateSnapshots?.['worker.custom'].instructions).toBe(
      'Frozen instructions.'
    );
  });
});
