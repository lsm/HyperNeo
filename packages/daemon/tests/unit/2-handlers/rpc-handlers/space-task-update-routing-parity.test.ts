import { describe, expect, mock, test } from 'bun:test';
import { isWorkflowRecoveryTransition } from '@hyperneo/shared';
import type {
  InternalEventBus,
  MessageHub,
  Space,
  SpaceTask,
  SpaceTaskStatus,
} from '@hyperneo/shared';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus';
import { setupSpaceTaskHandlers } from '../../../../src/lib/rpc-handlers/space-task-handlers';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import type { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager';
import type { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager';
import type { SpaceRuntimeService } from '../../../../src/lib/space/runtime/space-runtime-service';
import { routeTaskUpdate } from '../../../../src/lib/space/tools/task-transition-routing';

const NOW = Date.now();

const TEST_SPACE: Space = {
  id: 'space-1',
  slug: 'test-space',
  workspacePath: '/tmp/test-workspace',
  name: 'Test Space',
  description: '',
  backgroundContext: '',
  instructions: '',
  sessionIds: [],
  status: 'active',
  paused: false,
  stopped: false,
  maxConcurrentTasks: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

function makeTask(overrides: Partial<SpaceTask> = {}): SpaceTask {
  return {
    id: 'task-1',
    spaceId: 'space-1',
    taskNumber: 1,
    title: 'T',
    description: 'D',
    status: 'open',
    priority: 'normal',
    labels: [],
    dependsOn: [],
    result: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    blockReason: null,
    approvalSource: null,
    approvalReason: null,
    approvedAt: null,
    pendingCheckpointType: null,
    reportedStatus: null,
    reportedSummary: null,
    terminalGeneration: 0,
    ...overrides,
  };
}

interface Row {
  currentStatus: SpaceTaskStatus;
  requestedStatus?: SpaceTaskStatus;
  hasWorkflowRun?: boolean;
  runActive?: boolean;
  withField?: boolean;
}

function classify(row: Row, hasChanges = true) {
  const hasWorkflowRun = row.hasWorkflowRun ?? false;
  const differs = row.requestedStatus !== undefined && row.requestedStatus !== row.currentStatus;
  return routeTaskUpdate({
    hasChanges,
    taskExists: true,
    taskInSpace: true,
    currentStatus: row.currentStatus,
    requestedStatus: row.requestedStatus,
    statusDiffers: differs,
    hasWorkflowRun,
    runActive: hasWorkflowRun ? (row.runActive ?? false) : false,
    isRecoveryTransition: differs
      ? isWorkflowRecoveryTransition(row.currentStatus, row.requestedStatus as SpaceTaskStatus)
      : false,
    hasFieldUpdates: row.withField ?? false,
    taskId: 'task-1',
    workflowRunId: hasWorkflowRun ? 'run-1' : undefined,
  });
}

function actionOf(decision: ReturnType<typeof routeTaskUpdate>): string {
  return decision.action === 'reject' ? `reject:${decision.reason}` : decision.action;
}

interface DriveOpts {
  withRuntime?: boolean;
  extraParams?: Record<string, unknown>;
  taskOverrides?: Partial<SpaceTask>;
}

async function driveRpc(row: Row, opts: DriveOpts = {}) {
  const hasWorkflowRun = row.hasWorkflowRun ?? false;
  let current: SpaceTask = makeTask({
    status: row.currentStatus,
    workflowRunId: hasWorkflowRun ? 'run-1' : null,
    ...opts.taskOverrides,
  });
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
    }),
  } as unknown as MessageHub;
  const bus = {
    publish: mock(async () => ({ delivered: 0, failures: [] })),
  } as unknown as InternalEventBus<DaemonInternalEventMap>;
  const spaceManager = { getSpace: mock(async () => TEST_SPACE) } as unknown as SpaceManager;
  const workflowManager = { getWorkflow: mock(() => null) } as unknown as SpaceWorkflowManager;
  const updateTaskCalls: Array<Record<string, unknown>> = [];
  const seen: string[] = [];
  const taskManager = {
    getTask: mock(async () => current),
    updateTask: mock(async (_id: string, fields: Record<string, unknown>) => {
      updateTaskCalls.push(fields);
      current = { ...current, ...fields } as SpaceTask;
      return current;
    }),
    setTaskStatus: mock(async (_id: string, status: SpaceTaskStatus) => {
      seen.push('set_status');
      current = { ...current, status };
      return current;
    }),
  } as unknown as SpaceTaskManager;
  const withRuntime = opts.withRuntime ?? hasWorkflowRun;
  const runtime = withRuntime
    ? ({
        isWorkflowRunActive: mock(() => row.runActive ?? false),
        recoverWorkflowBackedTask: mock(async (_s: string, _t: string, status: SpaceTaskStatus) => {
          seen.push('recover_transition');
          current = { ...current, status };
          return current;
        }),
        stopWorkflowBackedTaskForStatus: mock(
          async (_s: string, _t: string, params: { status: SpaceTaskStatus }) => {
            seen.push('stop_for_status');
            current = { ...current, status: params.status };
            return current;
          }
        ),
        parkStoppedWorkflowTask: mock(async () => {
          seen.push('park_stopped');
          current = { ...current, status: 'stopped' };
          return current;
        }),
        stopWorkflowBackedTask: mock(async () => null),
      } as unknown as SpaceRuntimeService)
    : undefined;
  setupSpaceTaskHandlers(hub, spaceManager, workflowManager, () => taskManager, bus, runtime);
  const handler = handlers.get('spaceTask.update') as RequestHandler;
  const params: Record<string, unknown> = {
    spaceId: 'space-1',
    taskId: 'task-1',
    ...opts.extraParams,
  };
  if (row.requestedStatus !== undefined) params.status = row.requestedStatus;
  if (row.withField) params.priority = 'high';
  await handler(params);
  return { seen, updateTaskCalls };
}

function mapRejectReason(message: string): string {
  if (message.includes("into 'review' directly")) return 'review_direct';
  if (message.includes("into 'approved' directly")) return 'approved_direct';
  if (message.includes('active workflow run')) return 'archive_active_run';
  if (message.includes('Task not found')) return 'task_not_found';
  return `unmapped:${message}`;
}

async function observeAction(row: Row, opts: DriveOpts = {}): Promise<string> {
  try {
    const { seen } = await driveRpc(row, opts);
    return seen[0] ?? 'fields_only';
  } catch (error) {
    return `reject:${mapRejectReason((error as Error).message)}`;
  }
}

type MatrixRow = readonly [SpaceTaskStatus, SpaceTaskStatus | undefined, boolean, boolean, boolean];

function toRow([
  currentStatus,
  requestedStatus,
  hasWorkflowRun,
  runActive,
  withField,
]: MatrixRow): Row {
  return { currentStatus, requestedStatus, hasWorkflowRun, runActive, withField };
}

const MATRIX: MatrixRow[] = [
  ['done', 'open', true, false, false],
  ['done', 'in_progress', true, false, false],
  ['blocked', 'open', true, false, false],
  ['cancelled', 'open', true, false, false],
  ['stopped', 'in_progress', true, false, false],
  ['rate_limited', 'in_progress', true, false, false],
  ['blocked', 'open', false, false, false],
  ['in_progress', 'open', true, false, false],
  ['in_progress', 'cancelled', true, false, false],
  ['blocked', 'cancelled', true, false, false],
  ['stopped', 'open', true, false, false],
  ['rate_limited', 'blocked', true, false, false],
  ['in_progress', 'cancelled', false, false, false],
  ['in_progress', 'stopped', true, false, false],
  ['blocked', 'stopped', true, false, false],
  ['in_progress', 'stopped', false, false, false],
  ['blocked', 'archived', true, true, false],
  ['done', 'archived', true, false, false],
  ['open', 'review', false, false, false],
  ['open', 'review', true, false, false],
  ['in_progress', 'approved', false, false, false],
  ['open', undefined, false, false, true],
  ['in_progress', 'in_progress', false, false, true],
  ['open', 'in_progress', false, false, false],
];

describe('spaceTask.update status routing parity with routeTaskUpdate', () => {
  test.each(MATRIX)(
    '%s -> %s (wf=%s active=%s field=%s)',
    async (currentStatus, requestedStatus, hasWorkflowRun, runActive, withField) => {
      const row = toRow([currentStatus, requestedStatus, hasWorkflowRun, runActive, withField]);
      expect(await observeAction(row)).toBe(actionOf(classify(row)));
    }
  );
});

describe('known deltas (pinned current behavior, not fixed here)', () => {
  test.each([
    ['limited_direct', { currentStatus: 'in_progress', requestedStatus: 'rate_limited' } as Row],
    ['review_to_done', { currentStatus: 'review', requestedStatus: 'done' } as Row],
  ] as const)(
    '%s: the classifier rejects it, but the RPC handler allows it as a plain set_status',
    async (reason, row) => {
      expect(actionOf(classify(row))).toBe(`reject:${reason}`);
      expect(await observeAction(row)).toBe('set_status');
    }
  );

  test('archive_active_run: the RPC guard is silently skipped when SpaceRuntimeService is unwired', async () => {
    const row: Row = {
      currentStatus: 'blocked',
      requestedStatus: 'archived',
      hasWorkflowRun: true,
      runActive: true,
    };
    expect(actionOf(classify(row))).toBe('reject:archive_active_run');
    expect(await observeAction(row, { withRuntime: false })).toBe('set_status');
  });

  test('workspacePath: the RPC handler special-cases it on recovery; the classifier has no notion of it', async () => {
    const row: Row = { currentStatus: 'blocked', requestedStatus: 'open', hasWorkflowRun: true };
    expect(actionOf(classify(row))).toBe('recover_transition');
    const { seen, updateTaskCalls } = await driveRpc(row, {
      extraParams: { workspacePath: '/alt' },
    });
    expect(seen[0]).toBe('recover_transition');
    expect(updateTaskCalls).toContainEqual({ workspacePath: '/alt' });
  });

  test('workflowModelOverrides: the RPC handler can reject before the status decision is reached', async () => {
    const row: Row = { currentStatus: 'in_progress', requestedStatus: 'done' };
    expect(actionOf(classify(row))).toBe('set_status');
    await expect(
      driveRpc(row, {
        extraParams: { workflowModelOverrides: {} },
        taskOverrides: { startedAt: NOW - 1000 },
      })
    ).rejects.toThrow('Workflow model overrides are locked after the task starts');
  });

  test('no_updatable_fields: the classifier rejects an empty update; the RPC handler treats it as a no-op', async () => {
    const row: Row = { currentStatus: 'open' };
    expect(actionOf(classify(row, false))).toBe('reject:no_updatable_fields');
    const { updateTaskCalls } = await driveRpc(row);
    expect(updateTaskCalls).toEqual([{}]);
  });
});
