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
});
