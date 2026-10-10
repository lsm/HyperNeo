import { describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { Logger } from '../../../../src/lib/logger';
import type { SpaceTask } from '@hyperneo/shared';
import type { DirectTaskAttempt } from '../../../../src/storage/repositories/direct-task-execution-repository';
import {
  planDependentSettlement,
  settleTaskDependents,
  type DependentEvidence,
  type DependentSettlementDeps,
} from '../../../../src/lib/tasks/settle-dependents';
import { StaleTaskGuardError } from '../../../../src/lib/tasks/task-manager';

const task = (id: string, extra: Partial<SpaceTask> = {}) =>
  ({ id, spaceId: 's1', status: 'open', dependsOn: ['ended'], ...extra }) as SpaceTask;
const attempt = (sessionId = 'w', phase: DirectTaskAttempt['phase'] = 'running') =>
  ({ id: 'a1', sessionId, generation: 2, phase }) as DirectTaskAttempt;
const evidence = (
  dependent: SpaceTask,
  extra: Partial<DependentEvidence> = {}
): DependentEvidence => ({
  task: dependent,
  dependenciesDone: true,
  activeAttempt: null,
  ...extra,
});

describe('planDependentSettlement', () => {
  test('unblocks dependency-blocked dependents whose dependencies are all done', () => {
    const ready = task('d1', { status: 'blocked', blockReason: 'dependency_failed' });
    const waiting = task('d2', { status: 'blocked', blockReason: 'dependency_added' });
    const other = task('d3', { status: 'blocked', blockReason: 'human_input_requested' });
    expect(
      planDependentSettlement('done', [
        evidence(ready),
        evidence(waiting, { dependenciesDone: false }),
        evidence(other),
      ])
    ).toEqual([{ kind: 'unblock', task: ready }]);
  });

  test('on cancel blocks open work and stops running workflow and direct work', () => {
    const open = task('open');
    const workflow = task('wf', { status: 'in_progress', workflowRunId: 'r1' });
    const direct = task('direct', { status: 'rate_limited', taskAgentSessionId: 'w' });
    const manual = task('manual', { status: 'in_progress' });
    const done = task('done', { status: 'done' });
    expect(
      planDependentSettlement('cancelled', [
        evidence(open),
        evidence(workflow),
        evidence(direct, { activeAttempt: attempt() }),
        evidence(manual, { activeAttempt: attempt('someone-else') }),
        evidence(done),
      ])
    ).toEqual([
      { kind: 'block', task: open },
      { kind: 'stop_workflow', task: workflow },
      { kind: 'stop_direct', task: direct, attempt: attempt() },
      { kind: 'block', task: manual },
    ]);
  });

  test('settles nothing for other endings', () => {
    expect(planDependentSettlement('blocked', [evidence(task('open'))])).toEqual([]);
  });
});

describe('settleTaskDependents', () => {
  test('applies each settlement through its own effect and skips stale dependents', async () => {
    const ended = task('ended', { status: 'cancelled', dependsOn: [] });
    const open = task('open');
    const stale = task('stale');
    const workflow = task('wf', { status: 'in_progress', workflowRunId: 'r1' });
    const direct = task('direct', { status: 'in_progress', taskAgentSessionId: 'w' });
    const unrelated = task('unrelated', { dependsOn: [] });
    const writes: unknown[] = [];
    const deps: DependentSettlementDeps = {
      getTaskManager: () => ({
        listTasks: async () => [ended, open, stale, workflow, direct, unrelated],
        getTask: async () => null,
        setTaskStatus: async (id, status, options) => {
          if (id === 'stale') throw new StaleTaskGuardError('moved');
          writes.push(['set', id, status, options?.blockReason, options?.expectedStatus]);
          return { ...task(id), status };
        },
      }),
      getActiveAttempt: (id) => (id === 'direct' ? attempt() : null),
      stopForStatus: async (_spaceId, id, params, expected) => {
        writes.push(['stop', id, params.status, expected.expectedStatus]);
        return { ...workflow, status: 'blocked' };
      },
      requestDirectOutcome: (input) => {
        writes.push(['outcome', input.attemptId, input.status, input.options?.blockReason]);
        return { accepted: true, jobId: 'j1' };
      },
    };
    const settled = await settleTaskDependents(ended, deps);
    expect(writes).toEqual([
      ['set', 'open', 'blocked', 'dependency_failed', 'open'],
      ['stop', 'wf', 'blocked', 'in_progress'],
      ['outcome', 'a1', 'blocked', 'dependency_failed'],
    ]);
    expect(settled.map(({ id }) => id)).toEqual(['open', 'wf']);
  });

  test('one dependent that fails to settle does not stop the rest', async () => {
    const ended = task('ended', { status: 'done', dependsOn: [] });
    const broken = task('broken', { status: 'blocked', blockReason: 'dependency_failed' });
    const ready = task('ready', { status: 'blocked', blockReason: 'dependency_failed' });
    const tried: string[] = [];
    const deps: DependentSettlementDeps = {
      getTaskManager: () => ({
        listTasks: async () => [ended, broken, ready],
        getTask: async () => null,
        setTaskStatus: async (id, status) => {
          tried.push(id);
          if (id === 'broken') throw new Error('invalid transition');
          return { ...task(id), status };
        },
      }),
      getActiveAttempt: () => null,
      requestDirectOutcome: () => ({ accepted: true, jobId: null }),
    };
    const settled = await settleTaskDependents(ended, deps);
    expect(tried).toEqual(['broken', 'ready']);
    expect(settled.map(({ id }) => id)).toEqual(['ready']);
  });

  test('a rejected stop of a running direct dependent is reported, not silently dropped', async () => {
    const ended = task('ended', { status: 'cancelled', dependsOn: [] });
    const direct = task('direct', { status: 'in_progress', taskAgentSessionId: 'w' });
    const requested: string[] = [];
    const deps: DependentSettlementDeps = {
      getTaskManager: () => ({
        listTasks: async () => [ended, direct],
        getTask: async () => null,
        setTaskStatus: async () => {
          throw new Error('not reached');
        },
      }),
      getActiveAttempt: () => attempt(),
      requestDirectOutcome: (input) => {
        requested.push(input.attemptId);
        return { accepted: false, reason: 'direct_attempt_not_running' };
      },
    };
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    expect(await settleTaskDependents(ended, deps)).toEqual([]);
    expect(requested).toEqual(['a1']);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('direct_attempt_not_running');
    warn.mockRestore();
  });
});
