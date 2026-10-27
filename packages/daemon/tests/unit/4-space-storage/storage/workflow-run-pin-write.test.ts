import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import type { TableChange } from '../../../../src/storage/db-gateway/db-op.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { workflowRunPinWrites } from '../../../../src/storage/repositories/workflow-run-pin-write.ts';
import { computeDefinitionVersion } from '../../../../src/lib/workflows/definition-version.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

describe('workflow snapshot persistence', () => {
  let db: Database;
  let gateway: DbGateway;
  let changes: TableChange[];

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    gateway = new DbGateway(':memory:', db);
    changes = [];
    gateway.onChanges = (committed) => changes.push(...committed);
  });

  afterEach(async () => {
    await gateway.close();
    db.close();
  });

  function fixture() {
    const space = new SpaceRepository(db).createSpace({
      slug: 'snapshot',
      name: 'Snapshot',
      workspacePath: '/synthetic/workspace',
    });
    const workflow = new SpaceWorkflowRepository(db).createWorkflow({
      spaceId: space.id,
      name: 'Original',
      nodes: [],
    });
    const repository = new SpaceWorkflowRunRepository(db);
    const run = repository.createPinnedRun({
      spaceId: space.id,
      workflowId: workflow.id,
      title: 'Legacy',
      rawWorkflow: workflow,
    });
    return {
      repository,
      run,
      pin: {
        runId: run.id,
        workflowId: workflow.id,
        spaceId: space.id,
        ...computeDefinitionVersion({ ...workflow, templateSnapshots: {} }),
      },
    };
  }

  it('migrates an existing pin while normal pin admission keeps the original', async () => {
    const { repository, run, pin } = fixture();
    expect(await gateway.call(workflowRunPinWrites, 'pin', pin)).toBe(false);
    expect(repository.getRun(run.id)?.definitionVersion).toBe(run.definitionVersion);
    expect(await gateway.call(workflowRunPinWrites, 'migrateSnapshot', pin)).toBe(true);
    expect(repository.getRun(run.id)?.definitionVersion).toBe(pin.versionHash);
    expect(repository.getRun(run.id)?.title).toBe('Legacy');
    expect(
      changes.some(
        (change) => change.table === 'space_workflow_runs' && change.scope?.spaceId === pin.spaceId
      )
    ).toBe(true);
  });

  it('rolls back the snapshot and emits nothing when the pin update is refused', async () => {
    const { repository, run, pin } = fixture();
    db.exec(`CREATE TRIGGER refuse_snapshot BEFORE UPDATE OF definition_version ON space_workflow_runs
      BEGIN SELECT RAISE(ABORT, 'synthetic snapshot refusal'); END`);
    await expect(gateway.call(workflowRunPinWrites, 'migrateSnapshot', pin)).rejects.toThrow(
      'synthetic snapshot refusal'
    );
    expect(repository.getRun(run.id)?.definitionVersion).toBe(run.definitionVersion);
    expect(
      db
        .prepare('SELECT payload FROM space_workflow_definition_versions WHERE version_hash = ?')
        .get(pin.versionHash)
    ).toBeNull();
    expect(changes).toEqual([]);
  });
});
