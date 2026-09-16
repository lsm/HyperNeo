import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository';
import {
  createSubscriptionOperations,
  type SubscriptionDependencies,
  type SubscriptionSlot,
} from '../../../../src/lib/external-events/subscription-operations';
import type { OperationCaller, OperationDefinition } from '../../../../src/lib/operations/registry';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let sessions: SessionRepository;
let nodeExecutions: NodeExecutionRepository;
let operations: Map<string, OperationDefinition>;
let registered: Array<{ slot: SubscriptionSlot; topicPattern: string }>;
let unregistered: Array<{ slot: SubscriptionSlot; topicPattern: string }>;
let registerOutcome: { success: boolean; error?: string };
let registerThrows: Error | null;
let primaryLinkUrl: string;
let SPACE: string;
let RUN: string;
let TASK: string;

const LIST_RESULT = {
  workflowRunId: 'placeholder',
  nodeId: null,
  definitionResolved: true,
  declared: [],
  persisted: [],
  active: [],
  mismatches: { declaredNotActive: 0, persistedNotActive: 0, orphanActive: 0 },
};

function workerSession(
  id: string,
  options: { status?: 'active' | 'archived'; withExecution?: boolean } = {}
) {
  sessions.createSession(
    {
      ...createTestSession(id),
      workspacePath: '/repo',
      type: 'worker',
      status: options.status ?? 'active',
      context: { spaceId: SPACE, taskId: TASK },
    },
    { enforceWorkspaceOwnership: false }
  );
  if (options.withExecution !== false) {
    nodeExecutions.create({
      workflowRunId: RUN,
      workflowNodeId: 'node-a',
      agentName: 'coder',
      agentSessionId: id,
    });
  }
  return id;
}

function worker(sessionId: string): OperationCaller {
  return { source: 'mcp', sessionId, spaceId: SPACE, role: 'workflow_worker', agentName: 'coder' };
}

function run(name: string, input: unknown, caller: OperationCaller) {
  const operation = operations.get(name);
  if (!operation) throw new Error(`operation ${name} not registered`);
  return operation.execute(input, caller);
}

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  SPACE = new SpaceRepository(db).createSpace({
    name: 'Subs',
    slug: 'subs',
    workspacePath: '/repo',
  }).id;
  const workflow = new SpaceWorkflowRepository(db).createWorkflow({ spaceId: SPACE, name: 'W' });
  RUN = new SpaceWorkflowRunRepository(db).createRun({
    spaceId: SPACE,
    workflowId: workflow.id,
    title: 'Run',
  }).id;
  const taskRepo = new SpaceTaskRepository(db);
  TASK = taskRepo.createTask({ spaceId: SPACE, title: 'T', description: '' }).id;
  sessions = new SessionRepository(db);
  nodeExecutions = new NodeExecutionRepository(db);
  registered = [];
  unregistered = [];
  registerOutcome = { success: true };
  registerThrows = null;
  primaryLinkUrl = '';
  const deps: SubscriptionDependencies = {
    registerSubscription: (slot, topicPattern) => {
      if (registerThrows) throw registerThrows;
      registered.push({ slot, topicPattern });
      return registerOutcome;
    },
    unregisterSubscription: (slot, topicPattern) => {
      unregistered.push({ slot, topicPattern });
      return { success: true };
    },
    listRunSubscriptions: (workflowRunId) => ({
      success: true,
      result: { ...LIST_RESULT, workflowRunId },
    }),
    resolvePrimaryLinkUrl: () => primaryLinkUrl,
    getSession: (id) => sessions.getSession(id),
    taskRepo,
    nodeExecutionRepo: nodeExecutions,
    longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
  };
  operations = new Map(
    createSubscriptionOperations(deps).map((operation) => [operation.name, operation])
  );
});

afterEach(() => db.close());

describe('node external-event subscription operations', () => {
  test('subscribes with the slot resolved from the calling session', async () => {
    const caller = worker(workerSession('s-sub'));
    const result = await run(
      'externalEvent.subscribe',
      { topicPattern: 'github/acme/widgets/pull_request/*' },
      caller
    );
    expect(result).toEqual({ ok: true, topicPattern: 'github/acme/widgets/pull_request/*' });
    expect(registered).toHaveLength(1);
    expect(registered[0]!.slot).toEqual({
      workflowRunId: RUN,
      nodeId: 'node-a',
      agentName: 'coder',
      taskId: TASK,
    });
  });

  test('refuses an invalid topic glob without touching the runtime', async () => {
    const caller = worker(workerSession('s-bad'));
    const result = (await run('externalEvent.subscribe', { topicPattern: '///' }, caller)) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error.length).toBeGreaterThan(0);
    expect(registered).toEqual([]);
  });

  test('reports a runtime rejection as a result value', async () => {
    registerOutcome = { success: false, error: 'Workflow run not found: x' };
    const caller = worker(workerSession('s-reject'));
    expect(await run('externalEvent.subscribe', { topicPattern: 'github/a/b/*' }, caller)).toEqual({
      ok: false,
      error: 'Workflow run not found: x',
    });
  });

  test('turns an interest-cap throw into a result value', async () => {
    registerThrows = new Error('cannot register more than 8 event interests');
    const caller = worker(workerSession('s-cap'));
    expect(await run('externalEvent.subscribe', { topicPattern: 'github/a/b/*' }, caller)).toEqual({
      ok: false,
      error: 'cannot register more than 8 event interests',
    });
  });

  test('unsubscribes the same slot', async () => {
    const caller = worker(workerSession('s-unsub'));
    expect(
      await run('externalEvent.unsubscribe', { topicPattern: 'github/a/b/*' }, caller)
    ).toEqual({ ok: true, topicPattern: 'github/a/b/*' });
    expect(unregistered[0]!.topicPattern).toBe('github/a/b/*');
  });

  test('subscribe_pr_events derives the topic from the run primary link', async () => {
    primaryLinkUrl = 'https://github.com/acme/widgets/pull/42';
    const caller = worker(workerSession('s-pr'));
    expect(await run('subscribe_pr_events', {}, caller)).toEqual({
      ok: true,
      topicPattern: 'github/acme/widgets/pull_request/42.*',
    });
  });

  test('subscribe_pr_events prefers an explicit prUrl and reports an unparseable one', async () => {
    primaryLinkUrl = 'https://github.com/acme/widgets/pull/42';
    const caller = worker(workerSession('s-pr2'));
    expect(
      await run('subscribe_pr_events', { prUrl: 'https://github.com/acme/widgets/pull/7' }, caller)
    ).toEqual({ ok: true, topicPattern: 'github/acme/widgets/pull_request/7.*' });
    expect(await run('subscribe_pr_events', { prUrl: 'not-a-url' }, caller)).toEqual({
      ok: false,
      error: 'Could not parse GitHub PR URL: not-a-url',
    });
  });

  test('subscribe_pr_events explains an unresolved run PR', async () => {
    const caller = worker(workerSession('s-pr3'));
    expect(await run('subscribe_pr_events', {}, caller)).toEqual({
      ok: false,
      error: 'No PR URL found for this workflow run. Open a PR first or pass prUrl explicitly.',
    });
  });

  test('denies a space member that is not a workflow worker', async () => {
    const sessionId = workerSession('s-member', { withExecution: false });
    const caller: OperationCaller = {
      source: 'mcp',
      sessionId,
      spaceId: SPACE,
      role: 'ad_hoc_member',
    };
    expect(await run('externalEvent.subscribe', { topicPattern: 'github/a/b/*' }, caller)).toBe(
      'caller_denied'
    );
    expect(registered).toEqual([]);
  });

  test('refuses a subscription from an archived session and changes nothing', async () => {
    const caller = worker(workerSession('s-archived', { status: 'archived' }));
    expect(await run('externalEvent.subscribe', { topicPattern: 'github/a/b/*' }, caller)).toBe(
      'session_inactive'
    );
    expect(await run('externalEvent.unsubscribe', { topicPattern: 'github/a/b/*' }, caller)).toBe(
      'session_inactive'
    );
    expect(registered).toEqual([]);
    expect(unregistered).toEqual([]);
  });

  test('rejects node_unresolved when no node execution backs the session', async () => {
    const caller = worker(workerSession('s-orphan', { withExecution: false }));
    expect(await run('externalEvent.subscribe', { topicPattern: 'github/a/b/*' }, caller)).toBe(
      'node_unresolved'
    );
  });

  test('lists the run subscriptions resolved from the caller and accepts an explicit run', async () => {
    const caller = worker(workerSession('s-list'));
    expect(await run('externalEvent.listSubscriptions', {}, caller)).toEqual({
      ok: true,
      subscriptions: { ...LIST_RESULT, workflowRunId: RUN },
    });
    expect(
      await run('externalEvent.listSubscriptions', { workflowRunId: 'run-x' }, caller)
    ).toEqual({ ok: true, subscriptions: { ...LIST_RESULT, workflowRunId: 'run-x' } });
  });

  test('an archived worker session may still list subscriptions', async () => {
    const caller = worker(workerSession('s-list-archived', { status: 'archived' }));
    expect(await run('externalEvent.listSubscriptions', {}, caller)).toEqual({
      ok: true,
      subscriptions: { ...LIST_RESULT, workflowRunId: RUN },
    });
  });
});
