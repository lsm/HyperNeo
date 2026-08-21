import { describe, expect, test } from 'bun:test';
import { isWorkflowRecoveryTransition } from '@hyperneo/shared';
import {
  applyArgChangesGate,
  applyAutonomyGate,
  applyRoutingArbiter,
  applyTargetGate,
  decideUpdateTask,
  type SpaceToolCtx,
  type SpaceToolDecision,
  type SpaceToolInput,
} from '../../../../src/lib/space/tools/space-tool-pipeline.ts';
import {
  routeTaskUpdate,
  type TaskUpdateRoutingInput,
} from '../../../../src/lib/space/tools/task-transition-routing.ts';

function makeInput(overrides: Partial<SpaceToolInput> = {}): SpaceToolInput {
  return {
    toolName: 'update_task',
    level: 1,
    agentLevel: null,
    spaceLevel: 1,
    hasChanges: true,
    taskExists: true,
    taskInSpace: true,
    currentStatus: 'in_progress',
    requestedStatus: 'open',
    statusDiffers: true,
    hasWorkflowRun: false,
    runActive: false,
    isRecoveryTransition: false,
    hasFieldUpdates: false,
    taskId: 'task-1',
    workflowRunId: 'run-1',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<SpaceToolInput> = {}): SpaceToolCtx {
  return { ...makeInput(overrides), decision: null };
}

const routingTable: Partial<TaskUpdateRoutingInput>[] = [
  { hasChanges: false, taskExists: false, taskInSpace: false },
  { taskExists: false, taskInSpace: false, requestedStatus: 'review' },
  { taskInSpace: false, requestedStatus: 'review' },
  {
    currentStatus: 'open',
    requestedStatus: 'review',
    hasWorkflowRun: true,
    isRecoveryTransition: true,
  },
  {
    currentStatus: 'open',
    requestedStatus: 'approved',
    hasWorkflowRun: true,
    isRecoveryTransition: true,
  },
  { currentStatus: 'review', requestedStatus: 'done', hasWorkflowRun: true },
  {
    currentStatus: 'in_progress',
    requestedStatus: 'archived',
    hasWorkflowRun: true,
    runActive: true,
  },
  {
    currentStatus: 'in_progress',
    requestedStatus: 'archived',
    hasWorkflowRun: true,
    runActive: false,
  },
  { currentStatus: 'in_progress', requestedStatus: 'stopped', hasWorkflowRun: true },
  { currentStatus: 'in_progress', requestedStatus: 'stopped', hasWorkflowRun: false },
  {
    currentStatus: 'blocked',
    requestedStatus: 'open',
    hasWorkflowRun: true,
    isRecoveryTransition: true,
  },
  {
    currentStatus: 'blocked',
    requestedStatus: 'open',
    hasWorkflowRun: false,
    isRecoveryTransition: true,
  },
  { currentStatus: 'in_progress', requestedStatus: 'cancelled', hasWorkflowRun: true },
  { currentStatus: 'in_progress', requestedStatus: 'cancelled', hasWorkflowRun: false },
  { currentStatus: 'open', requestedStatus: 'in_progress' },
  { requestedStatus: undefined, statusDiffers: false },
  { currentStatus: 'in_progress', requestedStatus: 'in_progress', statusDiffers: false },
  { requestedStatus: undefined },
  { hasFieldUpdates: true, requestedStatus: 'stopped', hasWorkflowRun: true },
];
for (const currentStatus of [
  'in_progress',
  'blocked',
  'stopped',
  'rate_limited',
  'usage_limited',
] as const) {
  routingTable.push({ currentStatus, requestedStatus: 'cancelled', hasWorkflowRun: true });
}
for (const currentStatus of ['rate_limited', 'usage_limited'] as const) {
  routingTable.push({
    currentStatus,
    requestedStatus: 'blocked',
    hasWorkflowRun: true,
    isRecoveryTransition: isWorkflowRecoveryTransition(currentStatus, 'blocked'),
  });
}
for (const currentStatus of ['draft', 'open', 'review', 'approved', 'done', 'archived'] as const) {
  routingTable.push({
    currentStatus,
    requestedStatus: 'cancelled',
    hasWorkflowRun: true,
    isRecoveryTransition: isWorkflowRecoveryTransition(currentStatus, 'cancelled'),
  });
}

describe('space tool update_task decision pipeline', () => {
  const cases: Array<[string, Partial<SpaceToolInput>, SpaceToolDecision]> = [
    [
      'ungated update_task routes at the lowest autonomy level',
      {},
      { action: 'set_status', auditParamsShape: 'transition', emitTaskUpdated: 'always' },
    ],
    [
      'gated tool below the requirement denies with the space reason',
      { toolName: 'send_session_message', level: 3, spaceLevel: 3 },
      {
        action: 'deny',
        reason: 'space_autonomy_level',
        spaceLevel: 3,
        required: 4,
        message:
          'send_session_message not permitted: space autonomy level 3 < required level 4. Request human approval.',
      },
    ],
    [
      'gated tool under a binding agent ceiling denies with the ceiling reason',
      { toolName: 'update_session_state', level: 2, agentLevel: 2, spaceLevel: 5 },
      {
        action: 'deny',
        reason: 'agent_autonomy_ceiling',
        agentLevel: 2,
        spaceLevel: 5,
        required: 4,
        message:
          'update_session_state not permitted: agent autonomy ceiling 2 (space 5) < required level 4. Request human approval.',
      },
    ],
    [
      'gated tool at the required level still routes',
      { toolName: 'interrupt_session', level: 4, spaceLevel: 4 },
      { action: 'set_status', auditParamsShape: 'transition', emitTaskUpdated: 'always' },
    ],
    [
      'no updatable fields rejects',
      { hasChanges: false },
      {
        action: 'reject',
        reason: 'no_updatable_fields',
        message:
          'No fields to update. Provide at least one of: title, description, priority, depends_on, status.',
      },
    ],
    [
      'missing task rejects',
      { taskExists: false },
      { action: 'reject', reason: 'task_not_found', message: 'Task not found: task-1' },
    ],
    [
      'task outside the space rejects',
      { taskInSpace: false },
      {
        action: 'reject',
        reason: 'task_not_in_space',
        message: 'Task task-1 does not belong to this space.',
      },
    ],
    [
      'direct review transition rejects',
      { currentStatus: 'open', requestedStatus: 'review' },
      {
        action: 'reject',
        reason: 'review_direct',
        message:
          `update_task cannot transition a task into 'review' directly. ` +
          `Use submit_for_approval so the pending-completion fields get stamped ` +
          `and the approval banner renders.`,
      },
    ],
    [
      'direct approved transition rejects',
      { currentStatus: 'open', requestedStatus: 'approved' },
      {
        action: 'reject',
        reason: 'approved_direct',
        message:
          `update_task cannot transition a task into 'approved' directly. ` +
          `Use approve_pending_completion after submit_for_approval, or let the ` +
          `runtime's post-approval router handle the transition — both stamp ` +
          `the approval metadata and dispatch the configured post-approval step.`,
      },
    ],
    [
      'review to done rejects',
      { currentStatus: 'review', requestedStatus: 'done' },
      {
        action: 'reject',
        reason: 'review_to_done',
        message:
          `update_task cannot transition a task from 'review' to 'done' directly. ` +
          `Use approve_task (subject to the workflow's completion autonomy level) ` +
          `or submit_for_approval so a human can approve via the UI — both stamp ` +
          `the approval metadata and dispatch the configured post-approval step.`,
      },
    ],
    [
      'archiving an active workflow run rejects',
      { requestedStatus: 'archived', hasWorkflowRun: true, runActive: true },
      {
        action: 'reject',
        reason: 'archive_active_run',
        message:
          `Cannot archive task task-1: it belongs to an active workflow run ` +
          `(run-1). Cancel the task instead (cancel_task) so its ` +
          `agents and lifecycle are torn down — archiving would leave the run stranded.`,
      },
    ],
    [
      'stopping a workflow-backed task parks',
      { requestedStatus: 'stopped', hasWorkflowRun: true },
      {
        action: 'park_stopped',
        auditParamsShape: 'transition',
        emitTaskUpdated: 'only_with_field_updates',
      },
    ],
    [
      'workflow-backed recovery transition recovers',
      {
        currentStatus: 'blocked',
        requestedStatus: 'open',
        hasWorkflowRun: true,
        isRecoveryTransition: true,
      },
      {
        action: 'recover_transition',
        auditParamsShape: 'transition',
        emitTaskUpdated: 'only_with_field_updates',
      },
    ],
    [
      'workflow-backed active-to-open stops for status',
      { hasWorkflowRun: true },
      { action: 'stop_for_status', auditParamsShape: 'transition', emitTaskUpdated: 'never' },
    ],
    [
      'plain status change sets status',
      { currentStatus: 'open', requestedStatus: 'in_progress' },
      { action: 'set_status', auditParamsShape: 'transition', emitTaskUpdated: 'always' },
    ],
    [
      'status-equal update is fields-only',
      { requestedStatus: 'in_progress', statusDiffers: false },
      { action: 'fields_only', auditParamsShape: 'fields_only', emitTaskUpdated: 'always' },
    ],
    [
      'update without a requested status is fields-only',
      { requestedStatus: undefined, statusDiffers: false },
      { action: 'fields_only', auditParamsShape: 'fields_only', emitTaskUpdated: 'always' },
    ],
  ];

  for (const [label, overrides, expected] of cases) {
    test(label, () => {
      expect(decideUpdateTask(makeInput(overrides))).toEqual(expected);
    });
  }

  describe('gate precedence — first decision wins', () => {
    test('autonomy deny beats arg, target, and routing gates', () => {
      const decision = decideUpdateTask(
        makeInput({
          toolName: 'update_session_state',
          level: 1,
          agentLevel: 1,
          spaceLevel: 5,
          hasChanges: false,
          taskExists: false,
          taskInSpace: false,
          currentStatus: 'open',
          requestedStatus: 'review',
        })
      );
      expect(decision).toEqual({
        action: 'deny',
        reason: 'agent_autonomy_ceiling',
        agentLevel: 1,
        spaceLevel: 5,
        required: 4,
        message:
          'update_session_state not permitted: agent autonomy ceiling 1 (space 5) < required level 4. Request human approval.',
      });
    });

    test('arg-changes beats target gate', () => {
      const decision = decideUpdateTask(
        makeInput({ hasChanges: false, taskExists: false, taskInSpace: false })
      );
      expect(decision).toEqual({
        action: 'reject',
        reason: 'no_updatable_fields',
        message:
          'No fields to update. Provide at least one of: title, description, priority, depends_on, status.',
      });
    });

    test('target gate beats routing', () => {
      const missing = decideUpdateTask(
        makeInput({ taskExists: false, currentStatus: 'open', requestedStatus: 'review' })
      );
      expect(missing).toEqual({
        action: 'reject',
        reason: 'task_not_found',
        message: 'Task not found: task-1',
      });
      const foreign = decideUpdateTask(
        makeInput({ taskInSpace: false, currentStatus: 'open', requestedStatus: 'review' })
      );
      expect(foreign).toEqual({
        action: 'reject',
        reason: 'task_not_in_space',
        message: 'Task task-1 does not belong to this space.',
      });
    });

    test('routing arbiter decides when no earlier gate fires', () => {
      expect(decideUpdateTask(makeInput())).toEqual({
        action: 'set_status',
        auditParamsShape: 'transition',
        emitTaskUpdated: 'always',
      });
    });
  });

  describe('gate pass-through contract', () => {
    test('non-firing gates leave ctx untouched', () => {
      const noOpCases: Array<[(ctx: SpaceToolCtx) => SpaceToolCtx, Partial<SpaceToolInput>]> = [
        [applyAutonomyGate, { toolName: 'update_task', level: 1, spaceLevel: 1 }],
        [applyAutonomyGate, { toolName: 'update_task', level: 1, agentLevel: 1, spaceLevel: 5 }],
        [applyAutonomyGate, { toolName: 'send_session_message', level: 4, spaceLevel: 4 }],
        [
          applyAutonomyGate,
          { toolName: 'send_session_message', level: 4, agentLevel: 4, spaceLevel: 5 },
        ],
        [applyArgChangesGate, { hasChanges: true }],
        [applyTargetGate, { taskExists: true, taskInSpace: true }],
      ];
      for (const [gate, overrides] of noOpCases) {
        const ctx = makeCtx(overrides);
        expect(gate(ctx)).toBe(ctx);
      }
    });

    test('routing arbiter is the final gate and always decides', () => {
      for (const overrides of routingTable) {
        expect(applyRoutingArbiter(makeCtx(overrides)).decision).not.toBeNull();
      }
      expect(applyRoutingArbiter(makeCtx({})).decision).toEqual(routeTaskUpdate(makeInput({})));
    });
  });

  describe('pipeline output equals Core B across the full routing table', () => {
    test('ungated update_task mirrors routeTaskUpdate for every routing-table entry', () => {
      const actions = new Set<string>();
      for (const overrides of routingTable) {
        const decision = decideUpdateTask(makeInput(overrides));
        expect(decision).toEqual(routeTaskUpdate(makeInput(overrides)));
        actions.add(decision.action);
      }
      expect([...actions].sort()).toEqual([
        'fields_only',
        'park_stopped',
        'recover_transition',
        'reject',
        'set_status',
        'stop_for_status',
      ]);
    });

    test('autonomy-allowed gated tools mirror routeTaskUpdate for every routing-table entry', () => {
      for (const overrides of routingTable) {
        const input = makeInput({
          toolName: 'interrupt_session',
          level: 4,
          agentLevel: 4,
          spaceLevel: 5,
          ...overrides,
        });
        expect(decideUpdateTask(input)).toEqual(routeTaskUpdate(input));
      }
    });
  });
});
