import { beforeEach, describe, expect, test } from 'bun:test';
import { SpaceWorkflowEventSubscriptionRepository } from '../../../src/storage/repositories/space-workflow-event-subscription-repository';
import { createWorkflowEventSubscriptionTables } from '../../../src/storage/schema/workflow-event-subscriptions';
import { Database as BunDatabase } from '../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-1';
const RUN_ID = 'run-1';
const TASK_ID = 'task-1';
const NODE_ID = 'node-code';
const AGENT = 'coder';

function makeRepo(): { repo: SpaceWorkflowEventSubscriptionRepository; db: BunDatabase } {
  const db = new BunDatabase(':memory:');
  createWorkflowEventSubscriptionTables(db);
  return { repo: new SpaceWorkflowEventSubscriptionRepository(db), db };
}

function upsert(
  repo: SpaceWorkflowEventSubscriptionRepository,
  overrides: Partial<{
    spaceId: string;
    workflowRunId: string;
    taskId: string;
    nodeId: string;
    agentName: string;
    topic: string;
  }> = {}
) {
  repo.upsert({
    spaceId: SPACE_ID,
    workflowRunId: RUN_ID,
    taskId: TASK_ID,
    nodeId: NODE_ID,
    agentName: AGENT,
    topic: 'github/owner/repo/pull_request/42.*',
    subscriptionKind: 'dynamic',
    ...overrides,
  });
}

describe('SpaceWorkflowEventSubscriptionRepository', () => {
  let repo: SpaceWorkflowEventSubscriptionRepository;
  beforeEach(() => {
    ({ repo } = makeRepo());
  });

  test('upsert persists a subscription and lists it by space', () => {
    upsert(repo);
    const bySpace = repo.listBySpace(SPACE_ID);
    expect(bySpace).toHaveLength(1);
    const record = bySpace[0]!;
    expect(record.id).toBeTruthy();
    expect(record.workflowRunId).toBe(RUN_ID);
    expect(record.subscriptionKind).toBe('dynamic');
    expect(record.topic).toBe('github/owner/repo/pull_request/42.*');
    expect(record.topicNormalized).toBe('github/owner/repo/pull_request/42.*');
  });

  test('upsert is idempotent for the same slot+topic+kind (no duplicate row)', () => {
    upsert(repo);
    const idBefore = repo.listBySpace(SPACE_ID)[0]!.id;
    upsert(repo);
    const rows = repo.listBySpace(SPACE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(idBefore);
  });

  test('upsert dedups case-insensitively on topic', () => {
    upsert(repo, { topic: 'GitHub/Owner/Repo' });
    upsert(repo, { topic: 'github/owner/repo' });
    expect(repo.listBySpace(SPACE_ID)).toHaveLength(1);
    expect(repo.listBySpace(SPACE_ID)[0]!.topic).toBe('github/owner/repo');
  });

  test('upsert keeps distinct topics as separate rows', () => {
    upsert(repo, { topic: 'github/a' });
    upsert(repo, { topic: 'github/b' });
    upsert(repo, { topic: 'github/c' });
    expect(repo.listBySpace(SPACE_ID)).toHaveLength(3);
  });

  test('upsert rejects a non-dynamic subscription kind (CHECK constraint)', () => {
    expect(() =>
      repo.upsert({
        spaceId: SPACE_ID,
        workflowRunId: RUN_ID,
        taskId: TASK_ID,
        nodeId: NODE_ID,
        agentName: AGENT,
        topic: 'github/a',
        subscriptionKind: 'static' as 'dynamic',
      })
    ).toThrow();
    expect(repo.listBySpace(SPACE_ID)).toHaveLength(0);
  });

  test('deleteBySlotTopic removes only the matching slot+topic', () => {
    upsert(repo, { topic: 'github/a' });
    upsert(repo, { topic: 'github/b' });
    repo.deleteBySlotTopic(RUN_ID, TASK_ID, NODE_ID, AGENT, 'GITHUB/A', 'dynamic');
    const remaining = repo.listBySpace(SPACE_ID);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.topic).toBe('github/b');
  });

  test('deleteBySlot removes every topic for the agent slot', () => {
    upsert(repo, { topic: 'github/a' });
    upsert(repo, { topic: 'github/b' });
    upsert(repo, { topic: 'github/c', nodeId: 'other-node' });
    repo.deleteBySlot(RUN_ID, TASK_ID, NODE_ID, AGENT);
    const remaining = repo.listBySpace(SPACE_ID);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.nodeId).toBe('other-node');
  });

  test('deleteByRun removes every subscription for the run', () => {
    upsert(repo, { topic: 'github/a' });
    upsert(repo, { workflowRunId: 'run-2', topic: 'github/b' });
    repo.deleteByRun(RUN_ID);
    const bySpace = repo.listBySpace(SPACE_ID);
    expect(bySpace.filter((r) => r.workflowRunId === RUN_ID)).toHaveLength(0);
    expect(bySpace.filter((r) => r.workflowRunId === 'run-2')).toHaveLength(1);
  });

  test('deleteByTask removes every subscription for the task', () => {
    upsert(repo, { taskId: 'task-1', topic: 'github/a' });
    upsert(repo, { taskId: 'task-2', topic: 'github/b' });
    repo.deleteByTask('task-1');
    const remaining = repo.listBySpace(SPACE_ID);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.taskId).toBe('task-2');
  });
});
