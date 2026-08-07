import type { NodeExecution, SpaceTaskActivityMember } from '@hyperneo/shared';
import { describe, expect, it } from 'vitest';
import { resolveNodeClick } from '../node-click-resolver';

const label = (name: string) => name.replace(/\b\w/g, (c) => c.toUpperCase());

function nodeExec(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id: 'exec-1',
    workflowRunId: 'run-1',
    workflowNodeId: 'node-1',
    agentName: 'coder',
    agentId: 'agent-1',
    agentSessionId: 'session-coder',
    status: 'in_progress',
    result: null,
    data: null,
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

function member(overrides: Partial<SpaceTaskActivityMember> = {}): SpaceTaskActivityMember {
  return {
    id: 'm-1',
    sessionId: 'session-coder',
    kind: 'node_agent',
    label: 'Coder',
    role: 'coder',
    state: 'active',
    messageCount: 0,
    nodeExecution: {
      nodeExecutionId: 'exec-1',
      nodeId: 'node-1',
      agentName: 'coder',
      status: 'in_progress',
    },
    ...overrides,
  } as SpaceTaskActivityMember;
}

const baseArgs = {
  taskId: 'task-1',
  nodeName: 'Coding',
  workflowRunId: 'run-1',
  nodeExecutions: [] as NodeExecution[],
  activityMembers: [] as SpaceTaskActivityMember[],
  resolveLabel: label,
};

describe('resolveNodeClick', () => {
  it('opens the single live session for an active single-agent node', () => {
    const outcome = resolveNodeClick({
      ...baseArgs,
      nodeId: 'node-1',
      agentSlotNames: ['coder'],
      nodeExecutions: [nodeExec()],
    });
    expect(outcome).toEqual({
      type: 'open_session',
      taskId: 'task-1',
      session: {
        kind: 'live',
        sessionId: 'session-coder',
        agentName: 'coder',
        nodeExecutionId: 'exec-1',
        label: 'Coder',
      },
    });
  });

  it('opens a member-backed session matched by node ID, even when label differs from slot', () => {
    // Regression for the Review-node bug: label is 'Code Reviewer' but the slot
    // is 'reviewer'. Must resolve by nodeExecution.nodeId + slot name.
    const outcome = resolveNodeClick({
      ...baseArgs,
      nodeId: 'node-review',
      agentSlotNames: ['reviewer'],
      activityMembers: [
        member({
          id: 'm-review',
          sessionId: 'session-reviewer',
          label: 'Code Reviewer',
          role: 'reviewer',
          nodeExecution: {
            nodeExecutionId: 'exec-review',
            nodeId: 'node-review',
            agentName: 'reviewer',
            status: 'in_progress',
          },
        }),
      ],
    });
    expect(outcome.type).toBe('open_session');
    if (outcome.type === 'open_session') {
      expect(outcome.session.sessionId).toBe('session-reviewer');
      expect(outcome.session.label).toBe('Code Reviewer');
      expect(outcome.session.nodeExecutionId).toBe('exec-review');
    }
  });

  describe('active node A + unstarted node B', () => {
    // Two nodes; only node-1 (coder) is active. node-2 (reviewer) is unstarted.
    const nodeExecutions = [nodeExec()]; // coder only
    const activityMembers = [member()];

    it('clicking unstarted node B activates only B (never opens A)', () => {
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-2',
        agentSlotNames: ['reviewer'],
        nodeExecutions,
        activityMembers,
      });
      expect(outcome).toEqual({
        type: 'activate_slot',
        taskId: 'task-1',
        agentName: 'reviewer',
        nodeId: 'node-2',
      });
    });

    it('clicking active node A opens A only', () => {
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-1',
        agentSlotNames: ['coder'],
        nodeExecutions,
        activityMembers,
      });
      expect(outcome.type).toBe('open_session');
      if (outcome.type === 'open_session') {
        expect(outcome.session.sessionId).toBe('session-coder');
      }
    });

    it('B never resolves to A even when an unrelated session is live', () => {
      // Even if a stale/unrelated member for 'coder' exists, clicking node-2
      // must not return coder's session.
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-2',
        agentSlotNames: ['reviewer'],
        nodeExecutions,
        activityMembers,
      });
      if (outcome.type === 'open_session') {
        throw new Error('node B must not open a live session at all');
      }
      expect(outcome.type).toBe('activate_slot');
    });
  });

  describe('two nodes reusing the same slot name, disambiguated by node ID', () => {
    // Both node-1 and node-2 declare a 'reviewer' slot, each with its own
    // session. Clicking must pick the session for the clicked node ID only.
    const nodeExecutions = [
      nodeExec({
        id: 'exec-r1',
        workflowNodeId: 'node-1',
        agentName: 'reviewer',
        agentSessionId: 'session-reviewer-1',
      }),
      nodeExec({
        id: 'exec-r2',
        workflowNodeId: 'node-2',
        agentName: 'reviewer',
        agentSessionId: 'session-reviewer-2',
      }),
    ];

    it('clicking node-1 opens session-reviewer-1', () => {
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-1',
        agentSlotNames: ['reviewer'],
        nodeExecutions,
      });
      expect(outcome.type).toBe('open_session');
      if (outcome.type === 'open_session') {
        expect(outcome.session.sessionId).toBe('session-reviewer-1');
      }
    });

    it('clicking node-2 opens session-reviewer-2', () => {
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-2',
        agentSlotNames: ['reviewer'],
        nodeExecutions,
      });
      expect(outcome.type).toBe('open_session');
      if (outcome.type === 'open_session') {
        expect(outcome.session.sessionId).toBe('session-reviewer-2');
      }
    });
  });

  describe('spawned post-approval merger node', () => {
    it('opens the merger session once postApprovalSessionId is available', () => {
      // Merger has no node_execution row; identity comes from the task.
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-merger',
        nodeName: 'Post-Approval',
        agentSlotNames: ['merger'],
        postApprovalSessionId: 'session-merger',
        postApprovalTargetAgent: 'merger',
      });
      expect(outcome.type).toBe('open_session');
      if (outcome.type === 'open_session') {
        expect(outcome.session.sessionId).toBe('session-merger');
        expect(outcome.session.agentName).toBe('merger');
      }
    });

    it('before the merger is spawned, activates the merger slot (own identity, no fallback)', () => {
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-merger',
        agentSlotNames: ['merger'],
        postApprovalSessionId: null,
        postApprovalTargetAgent: 'merger',
      });
      expect(outcome).toEqual({
        type: 'activate_slot',
        taskId: 'task-1',
        agentName: 'merger',
        nodeId: 'node-merger',
      });
    });

    it('does not open the merger session when clicking a different node', () => {
      // The post-approval session must not leak onto an unrelated node click.
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-coder',
        agentSlotNames: ['coder'],
        postApprovalSessionId: 'session-merger',
        postApprovalTargetAgent: 'merger',
      });
      expect(outcome.type).not.toBe('open_session');
    });

    it('binds the merger session only to postApprovalNodeId (not every same-named node)', () => {
      // Two nodes both declare the 'merger' slot. With postApprovalNodeId set,
      // only the resolved merger node opens postApprovalSessionId; the other
      // same-named node must NOT bind the singular merger session.
      const onMerger = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-merger',
        agentSlotNames: ['merger'],
        postApprovalSessionId: 'session-merger',
        postApprovalTargetAgent: 'merger',
        postApprovalNodeId: 'node-merger',
      });
      expect(onMerger.type).toBe('open_session');

      const onImposter = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-merger-2',
        nodeName: 'Other Merger',
        agentSlotNames: ['merger'],
        postApprovalSessionId: 'session-merger',
        postApprovalTargetAgent: 'merger',
        postApprovalNodeId: 'node-merger',
      });
      // The imposter node also declares 'merger' but is not the bound node —
      // it must not open the merger session (it falls through to activate_slot).
      expect(onImposter.type).toBe('activate_slot');
      if (onImposter.type === 'activate_slot') {
        expect(onImposter.nodeId).toBe('node-merger-2');
      }
    });
  });

  describe('zero-agent node', () => {
    it('returns an empty state and never falls back', () => {
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-empty',
        nodeName: 'Sink',
        agentSlotNames: [],
        nodeExecutions: [nodeExec()], // an unrelated live session exists
        activityMembers: [member()],
      });
      expect(outcome).toEqual({ type: 'empty', nodeName: 'Sink' });
    });
  });

  describe('multi-agent node', () => {
    const slots = ['architecture-reviewer', 'security-reviewer', 'correctness-reviewer'];

    it('opens the single active slot when only one is live', () => {
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-plan-review',
        agentSlotNames: slots,
        nodeExecutions: [
          nodeExec({
            id: 'exec-sec',
            workflowNodeId: 'node-plan-review',
            agentName: 'security-reviewer',
            agentSessionId: 'session-sec',
          }),
        ],
      });
      expect(outcome.type).toBe('open_session');
      if (outcome.type === 'open_session') {
        expect(outcome.session.sessionId).toBe('session-sec');
      }
    });

    it('presents a choice when multiple slots are live (no arbitrary selection)', () => {
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-plan-review',
        agentSlotNames: slots,
        nodeExecutions: [
          nodeExec({
            id: 'exec-arch',
            workflowNodeId: 'node-plan-review',
            agentName: 'architecture-reviewer',
            agentSessionId: 'session-arch',
          }),
          nodeExec({
            id: 'exec-sec',
            workflowNodeId: 'node-plan-review',
            agentName: 'security-reviewer',
            agentSessionId: 'session-sec',
          }),
        ],
      });
      expect(outcome.type).toBe('choose');
      if (outcome.type === 'choose') {
        expect(outcome.choices).toHaveLength(2);
        // ordered by declared slot order
        expect((outcome.choices[0] as { agentName: string }).agentName).toBe(
          'architecture-reviewer'
        );
        expect((outcome.choices[1] as { agentName: string }).agentName).toBe('security-reviewer');
      }
    });

    it('presents a choice when no slot is live yet (multi-slot unstarted)', () => {
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-plan-review',
        agentSlotNames: slots,
      });
      expect(outcome.type).toBe('choose');
      if (outcome.type === 'choose') {
        expect(outcome.choices.every((c) => c.kind === 'pending')).toBe(true);
        expect(outcome.choices).toHaveLength(3);
        // Each pending choice carries the clicked node ID for activation routing.
        expect(
          outcome.choices.every((c) => c.kind === 'pending' && c.nodeId === 'node-plan-review')
        ).toBe(true);
      }
    });
  });

  describe('identity safety', () => {
    it('skips members whose node ID is unknown (rollout-era nullable identity)', () => {
      // A live member with no nodeExecution.nodeId must never be guessed to
      // belong to the clicked node.
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-2',
        agentSlotNames: ['reviewer'],
        activityMembers: [
          member({
            id: 'm-orphan',
            sessionId: 'session-orphan',
            role: 'reviewer',
            label: 'Reviewer',
            nodeExecution: null,
          }),
        ],
      });
      expect(outcome.type).toBe('activate_slot');
    });

    it('ignores sessions for a different node ID even with a matching slot', () => {
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-2',
        agentSlotNames: ['reviewer'],
        nodeExecutions: [
          nodeExec({
            id: 'exec-other',
            workflowNodeId: 'node-1',
            agentName: 'reviewer',
            agentSessionId: 'session-other',
          }),
        ],
      });
      expect(outcome.type).toBe('activate_slot');
    });

    it('scopes nodeExecutions to the task run only', () => {
      // Same node ID in a different run must not match.
      const outcome = resolveNodeClick({
        ...baseArgs,
        nodeId: 'node-1',
        agentSlotNames: ['coder'],
        nodeExecutions: [
          nodeExec({
            workflowRunId: 'run-OTHER',
            workflowNodeId: 'node-1',
            agentName: 'coder',
            agentSessionId: 'session-other-run',
          }),
        ],
      });
      expect(outcome.type).toBe('activate_slot');
    });
  });
});
