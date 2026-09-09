import { createDaemonServer, type DaemonServerContext } from '../../../helpers/daemon-server';
import type { Space, SpaceWorkflow } from '@hyperneo/shared';

export interface TestSpaceFixture {
  space: Space;
  workflow: SpaceWorkflow;
}

export async function createTestSpace(daemon: DaemonServerContext): Promise<TestSpaceFixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const space = (await daemon.messageHub.request('space.create', {
    name: `Test Space ${suffix}`,
    description: 'Integration test space — plan-to-approve flow',
    workspacePath: process.cwd(),
    autonomyLevel: 1,
  })) as Space;

  const { workflow } = (await daemon.messageHub.request('spaceWorkflow.create', {
    spaceId: space.id,
    name: 'TEST_FULL_CYCLE_WORKFLOW',
    description: 'Deterministic online-test workflow for gate/channel integration coverage',
    nodes: [
      {
        id: 'planning-node',
        name: 'Planning',
        agents: [{ agentId: '', name: 'planner', templateKey: 'worker.research' }],
      },
      {
        id: 'plan-review-node',
        name: 'Plan Review',
        agents: [{ agentId: '', name: 'reviewer', templateKey: 'worker.reviewer' }],
      },
      {
        id: 'coding-node',
        name: 'Coding',
        agents: [{ agentId: '', name: 'coder', templateKey: 'worker.swe' }],
      },
      {
        id: 'code-review-node',
        name: 'Code Review',
        agents: [
          { agentId: '', name: 'Reviewer 1', templateKey: 'worker.reviewer' },
          { agentId: '', name: 'Reviewer 2', templateKey: 'worker.reviewer' },
          { agentId: '', name: 'Reviewer 3', templateKey: 'worker.reviewer' },
        ],
      },
      {
        id: 'qa-node',
        name: 'QA',
        agents: [{ agentId: '', name: 'qa', templateKey: 'worker.qa' }],
      },
      {
        id: 'done-node',
        name: 'Done',
        agents: [{ agentId: '', name: 'done', templateKey: 'worker.qa' }],
      },
    ],
    startNodeId: 'planning-node',
    endNodeId: 'done-node',
    gates: [
      {
        id: 'plan-pr-gate',
        description: 'Planning PR URL is available',
        fields: [{ name: 'pr_url', type: 'string', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      },
      {
        id: 'plan-approval-gate',
        description: 'Plan is approved',
        fields: [
          {
            name: 'approved',
            type: 'boolean',
            writers: [],
            check: { op: '==', value: true },
          },
        ],
        resetOnCycle: true,
      },
      {
        id: 'code-pr-gate',
        description: 'Coding PR URL is available for review',
        fields: [{ name: 'pr_url', type: 'string', writers: ['*'], check: { op: 'exists' } }],
        resetOnCycle: false,
      },
      {
        id: 'review-votes-gate',
        description: 'All reviewers approved',
        fields: [
          {
            name: 'votes',
            type: 'map',
            writers: [],
            check: { op: 'count', match: 'approved', min: 3 },
          },
        ],
        resetOnCycle: true,
      },
      {
        id: 'review-reject-gate',
        description: 'Any reviewer rejected',
        fields: [
          {
            name: 'votes',
            type: 'map',
            writers: [],
            check: { op: 'count', match: 'rejected', min: 1 },
          },
        ],
        resetOnCycle: true,
      },
      {
        id: 'qa-result-gate',
        description: 'QA passed',
        fields: [
          {
            name: 'result',
            type: 'string',
            writers: ['qa'],
            check: { op: '==', value: 'passed' },
          },
        ],
        resetOnCycle: true,
      },
      {
        id: 'qa-fail-gate',
        description: 'QA failed and needs fixes',
        fields: [
          {
            name: 'result',
            type: 'string',
            writers: ['qa'],
            check: { op: '==', value: 'failed' },
          },
        ],
        resetOnCycle: true,
      },
    ],
    channels: [
      {
        from: 'Planning',
        to: 'Plan Review',
        gateId: 'plan-pr-gate',
        label: 'Planning → Plan Review',
      },
      {
        from: 'Plan Review',
        to: 'Coding',
        gateId: 'plan-approval-gate',
        label: 'Plan Review → Coding',
      },
      {
        from: 'Coding',
        to: 'Code Review',
        gateId: 'code-pr-gate',
        label: 'Coding → Code Review',
      },
      {
        from: 'Code Review',
        to: 'QA',
        gateId: 'review-votes-gate',
        label: 'Code Review → QA',
      },
      {
        from: 'Code Review',
        to: 'Coding',
        maxCycles: 5,
        gateId: 'review-reject-gate',
        label: 'Code Review → Coding (rejection loop)',
      },
      {
        from: 'QA',
        to: 'Done',
        gateId: 'qa-result-gate',
        label: 'QA → Done',
      },
      {
        from: 'QA',
        to: 'Coding',
        maxCycles: 5,
        gateId: 'qa-fail-gate',
        label: 'QA → Coding (fix loop)',
      },
    ],
    completionAutonomyLevel: 3,
    tags: ['v2', 'test'],
  })) as { workflow: SpaceWorkflow };

  return { space, workflow };
}

export async function restartDaemon(daemon: DaemonServerContext): Promise<DaemonServerContext> {
  const { workspacePath } = daemon;

  if (!workspacePath) {
    throw new Error(
      'restartDaemon: workspacePath not found on daemon context — only works with ' +
        'in-process mode (do not set DAEMON_TEST_SPAWN=true for restart tests)'
    );
  }

  daemon.kill('SIGTERM');
  await daemon.waitForExit();

  return createDaemonServer({ workspacePath });
}
