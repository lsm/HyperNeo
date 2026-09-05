import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { createSpaceTables } from '../../helpers/space-test-db.ts';

describe('SpaceWorkflowRepository — getWorkflowsReferencingAgent', () => {
  let db: Database;
  let repo: SpaceWorkflowRepository;
  const spaceId = 'sp-1';

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run(spaceId, spaceId, '/ws/x', 'Test Space', now, now);
    repo = new SpaceWorkflowRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test('matches the referenced agent exactly, not by id prefix', () => {
    repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'agent-2' }],
    });

    expect(repo.getWorkflowsReferencingAgent('agent')).toHaveLength(0);
    expect(repo.getWorkflowsReferencingAgent('agent-2')).toHaveLength(1);
  });

  test('does not treat ids mentioned only in instructions as references', () => {
    repo.createWorkflow({
      spaceId,
      name: 'WF',
      nodes: [{ name: 'Only', agentId: 'other-agent', instructions: 'ping agent-1' }],
    });

    expect(repo.getWorkflowsReferencingAgent('agent-1')).toHaveLength(0);
  });
});
