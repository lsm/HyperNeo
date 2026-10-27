import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DbGateway, bindGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import type { TableChange } from '../../../../src/storage/db-gateway/db-op.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import {
  SpaceWorkflowManager,
  WorkflowDeletionBlockedError,
} from '../../../../src/lib/workflows/workflow-manager.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

describe('asynchronous workflow deletion', () => {
  let db: Database;
  let gateway: DbGateway;
  let repo: SpaceWorkflowRepository;
  let manager: SpaceWorkflowManager;
  let changes: TableChange[];
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    gateway = new DbGateway(':memory:', db);
    bindGateway(db, gateway);
    changes = [];
    gateway.onChanges = (committed) => changes.push(...committed);
    repo = new SpaceWorkflowRepository(db);
    manager = new SpaceWorkflowManager(repo);
    spaceId = new SpaceRepository(db).createSpace({
      slug: 'delete',
      name: 'Delete',
      workspacePath: '/synthetic/workspace',
    }).id;
  });

  afterEach(async () => {
    await gateway.close();
    db.close();
  });

  function workflow() {
    return repo.createWorkflow({
      spaceId,
      name: 'Disposable',
      nodes: [{ name: 'Start', agents: [] }],
    });
  }

  it('deletes nodes while retaining immutable history and returns false for an absent workflow', async () => {
    const created = workflow();
    expect(await manager.deleteWorkflowAsync(created.id)).toBe(true);
    expect(repo.getWorkflow(created.id)).toBeNull();
    expect(
      db
        .prepare('SELECT count(*) AS n FROM space_workflow_nodes WHERE workflow_id = ?')
        .get(created.id)
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          'SELECT count(*) AS n FROM space_workflow_definition_versions WHERE workflow_id = ?'
        )
        .get(created.id)
    ).toEqual({ n: 1 });
    expect(changes.map((change) => change.table)).toEqual([
      'space_workflows',
      'space_workflow_nodes',
    ]);
    expect(await manager.deleteWorkflowAsync(created.id)).toBe(false);
  });

  it('preserves the typed deletion refusal for an executable taskless run', async () => {
    const created = workflow();
    const run = new SpaceWorkflowRunRepository(db).createRun({
      spaceId,
      workflowId: created.id,
      title: 'Executable',
    });
    await expect(manager.deleteWorkflowAsync(created.id)).rejects.toBeInstanceOf(
      WorkflowDeletionBlockedError
    );
    expect(repo.getWorkflow(created.id)?.id).toBe(created.id);
    expect(new SpaceWorkflowRunRepository(db).getRun(run.id)?.id).toBe(run.id);
    expect(changes).toEqual([]);
  });

  it('retains the workflow and emits nothing when deletion fails', async () => {
    const created = workflow();
    db.exec(
      `CREATE TRIGGER refuse_workflow BEFORE DELETE ON space_workflows BEGIN SELECT RAISE(ABORT, 'synthetic workflow refusal'); END`
    );
    await expect(manager.deleteWorkflowAsync(created.id)).rejects.toThrow(
      'synthetic workflow refusal'
    );
    expect(repo.getWorkflow(created.id)?.nodes).toEqual(created.nodes);
    expect(changes).toEqual([]);
  });
});
