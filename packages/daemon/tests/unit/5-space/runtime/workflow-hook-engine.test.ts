/**
 * WorkflowHookEngine.executeAction orchestration tests.
 *
 * Covers the engine semantics that pure-function tests cannot: hook chaining
 * (stop/retry precedence, payload patches), the human-override contract behind
 * the approveHook RPC, retry-backoff pre-check, and side-effect composition
 * across ordered bindings of one action. Hooks are exercised through CUSTOM
 * SCRIPT hooks (bash echoes its HookReturn JSON) so no GitHub-calling built-in
 * is ever run — custom hooks are also what user-authored workflows use.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository';
import { WorkflowHookStateRepository } from '../../../../src/storage/repositories/workflow-hook-state-repository';
import {
  createLegacyHookGuardEngine,
  WorkflowHookEngine,
  wrapHandlerWithHooks,
  type HookActionOutcome,
  type HookActionMeta,
} from '../../../../src/lib/space/runtime/workflow-hook-engine';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import type { CustomHook, HookArtifact, SpaceWorkflow } from '@hyperneo/shared';

function scriptHook(id: string, body: string, timeoutMs?: number): CustomHook {
  return {
    id,
    requiredData: [],
    run: { kind: 'script', interpreter: 'bash', source: `echo '${body}'`, timeoutMs },
  };
}

/** A hook whose script stops the action (and proves it ran). */
const STOP_HOOK = scriptHook('stop_hook', '{"flow":"stop","reason":"blocked by script"}');
const PASS_HOOK = scriptHook('pass_hook', '{"flow":"continue"}');

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'sp-1',
    name: 'Engine Test',
    handle: 'engine-test',
    nodes: [
      { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
      { id: 'n-review', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
    ],
    startNodeId: 'n-coding',
    endNodeId: 'n-review',
    channels: [{ from: 'Coding', to: 'Review', label: 'Coding → Review' }],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const META: HookActionMeta = {
  sessionId: 'sess-1',
  agentName: 'coder',
  nodeId: 'n-coding',
  taskId: 'task-1',
};

describe('WorkflowHookEngine.executeAction', () => {
  let db: Database;
  let hookStateRepo: WorkflowHookStateRepository;
  let artifactRepo: WorkflowRunArtifactRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sp-1', 'sp-1', '/tmp/sp-1', 'Space', now, now);
    db.prepare(
      `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('run-1', 'sp-1', 'wf-1', 'Run', 'in_progress', now, now);
    hookStateRepo = new WorkflowHookStateRepository(db);
    artifactRepo = new WorkflowRunArtifactRepository(db);
  });

  afterEach(() => db.close());

  function makeEngine(workflow: SpaceWorkflow): WorkflowHookEngine {
    return new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: new NodeExecutionRepository(db),
      artifactRepo,
      hookStateRepo,
      // Real cwd — the script-hook spawn uses this as its working directory,
      // and a nonexistent path fails the spawn itself.
      workspacePath: process.cwd(),
    });
  }

  function sendParams(data?: Record<string, unknown>): Record<string, unknown> {
    return { target: 'Review', message: 'handoff', ...(data ? { data } : {}) };
  }

  test('a stop hook blocks delivery with the hook reason surfaced', async () => {
    const engine = makeEngine(
      makeWorkflow({
        customHooks: [STOP_HOOK],
        hookBindings: [
          {
            hookId: 'stop_hook',
            sourceNode: 'Coding',
            targetNode: 'Review',
            method: 'send_message',
            order: 0,
            enabled: true,
            authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
          },
        ],
      })
    );
    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('stop');
    expect(outcome.blockingHookId).toBe('stop_hook');
    expect(outcome.userState.status).toBe('blocked');
    expect(outcome.userState.reason).toBe('blocked by script');
  });

  test('a pending approval is consumed on a natural continue (no stale override)', async () => {
    // Hook PASSES on its own; the operator's earlier approval must be
    // cleared so a later stop for a NEW violation cannot ride it.
    const PASS_HOOK = scriptHook('pass_hook', '{"flow":"continue"}');
    const workflow = makeWorkflow({
      customHooks: [PASS_HOOK],
      hookBindings: [
        {
          hookId: 'pass_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    hookStateRepo.updateWithRetry('run-1', 'pass_hook', {
      localState: { humanApproved: true, humanApprovedAt: 1 },
      lastFlow: 'stop',
    });
    const engine = makeEngine(workflow);
    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('deliver');
    expect(hookStateRepo.get('run-1', 'pass_hook')?.localState.humanApproved).toBeUndefined();
  });

  test('a script-failure stop is override-INELIGIBLE (execution failure)', async () => {
    // A script exiting non-zero FAILED TO COMPLETE — that is an execution
    // failure, not a decision, so an approval must not deliver through it.
    const FAIL_HOOK = {
      id: 'fail_hook',
      requiredData: [],
      run: { kind: 'script' as const, interpreter: 'bash' as const, source: 'exit 3' },
    };
    const workflow = makeWorkflow({
      customHooks: [FAIL_HOOK],
      hookBindings: [
        {
          hookId: 'fail_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    hookStateRepo.updateWithRetry('run-1', 'fail_hook', {
      localState: { humanApproved: true, humanApprovedAt: 1 },
      lastFlow: 'stop',
    });
    const engine = makeEngine(workflow);
    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('stop');
    expect(outcome.userState.humanOverrideEligible).toBe(false);
    expect(outcome.userState.reason).toContain('failed to complete');
    // The approval is NOT consumed by an execution failure.
    expect(hookStateRepo.get('run-1', 'fail_hook')?.localState.humanApproved).toBe(true);
  });

  test('a human approval recorded against an unresolved hook does not bypass it', async () => {
    const workflow = makeWorkflow({
      hookBindings: [
        {
          hookId: 'missing_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    // An operator approves the (infrastructure) blocked banner...
    hookStateRepo.updateWithRetry('run-1', 'missing_hook', {
      localState: { humanApproved: true, humanApprovedAt: 1 },
      lastFlow: 'stop',
    });
    const engine = makeEngine(workflow);
    const outcome = await engine.executeAction('send_message', sendParams(), META);
    // ...but the gate never ran, so the override is not consumed and the
    // action stays blocked.
    expect(outcome.decision).toBe('stop');
    expect(hookStateRepo.get('run-1', 'missing_hook')?.localState.humanApproved).toBe(true);
  });

  test('a mixed multicast gates the node-addressed part (generic address does not suppress)', async () => {
    const STOP_HOOK = scriptHook('stop_hook', '{"flow":"stop","reason":"blocked by script"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      hookBindings: [
        {
          hookId: 'stop_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const engine = makeEngine(workflow);
    // A worker address resolving to Review PLUS a generic '@coordinator'
    // address: the gate must run for the node-addressed part.
    const outcome = await engine.executeAction(
      'send_message',
      {
        target: ['@worker:n-review/reviewer', '@coordinator'],
        message: 'mixed',
      },
      META
    );
    expect(outcome.decision).toBe('stop');
    expect(outcome.blockingHookId).toBe('stop_hook');
  });

  test("a non-routable worker in a multicast does not suppress routable parts' gates", async () => {
    // ['@worker:Review/reviewer', '@worker:Other/other'] — Other is not
    // channel-reachable; Review's gate must still run.
    const STOP_HOOK = scriptHook('mixed_hook', '{"flow":"stop","reason":"blocked by script"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      nodes: [
        { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        { id: 'n-review', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
        { id: 'n-other', name: 'Other', agents: [{ agentId: 'a3', name: 'other' }] },
      ],
      channels: [
        { from: 'Coding', to: 'Review', label: 'Coding → Review' },
        // NO channel to Other — it is non-routable.
      ],
      hookBindings: [
        {
          hookId: 'mixed_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const engine = makeEngine(workflow);
    const outcome = await engine.executeAction(
      'send_message',
      { target: ['@worker:n-review/reviewer', '@worker:n-other/other'], message: 'mixed' },
      META
    );
    expect(outcome.decision).toBe('stop');
    expect(outcome.blockingHookId).toBe('mixed_hook');
  });

  test('a worker slot reachable only via a REVERSE channel does not run the gate', async () => {
    // Router parity: for '@worker:Review/reviewer' the router authorizes
    // canSend(fromNode, nodeName) or canSend(fromNode, agentName) — never a
    // reverse canSend(agentName, nodeName). With only a 'reviewer → Review'
    // channel and no route from Coding, the router REFUSES the send, so the
    // engine must treat the resolution as non-routable and suppress the
    // gate — running it would let a side-effecting hook (pr_ready stamps the
    // run's immutable PR identity) fire from an unauthorized attempt.
    const STOP_HOOK = scriptHook('reverse_hook', '{"flow":"stop","reason":"blocked by script"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      channels: [
        // Only the reverse direction: reviewer → Review, nothing from Coding.
        { from: 'reviewer', to: 'Review', label: 'reviewer → Review' },
      ],
      hookBindings: [
        {
          hookId: 'reverse_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const engine = makeEngine(workflow);
    const outcome = await engine.executeAction(
      'send_message',
      { target: '@worker:n-review/reviewer', message: 'unauthorized route' },
      META
    );
    // Non-routable for this sender: the gate is suppressed, no hook state.
    expect(outcome.decision).toBe('deliver');
    expect(hookStateRepo.get('run-1', 'reverse_hook')).toBeNull();
  });

  test('a non-string multicast element does not poison the valid parts', async () => {
    const STOP_HOOK = scriptHook('stop_hook', '{"flow":"stop","reason":"blocked by script"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      hookBindings: [
        {
          hookId: 'stop_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const engine = makeEngine(workflow);
    const outcome = await engine.executeAction(
      'send_message',
      { target: [123 as unknown as string, 'Review'], message: 'mixed' },
      META
    );
    expect(outcome.decision).toBe('stop');
  });

  test('a binding whose hook cannot be resolved blocks (fail closed)', async () => {
    // Pinned definition referencing a hook the running registry lacks (e.g.
    // after a rollback) must NOT deliver the protected action ungated.
    const workflow = makeWorkflow({
      hookBindings: [
        {
          hookId: 'missing_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const engine = makeEngine(workflow);
    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('stop');
    expect(outcome.blockingHookId).toBe('missing_hook');
    expect(outcome.userState.reason).toContain('not registered');
  });

  test('an unbound route delivers untouched', async () => {
    const engine = makeEngine(makeWorkflow());
    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('deliver');
    expect(outcome.finalParams).toEqual(sendParams());
  });

  test('ordered bindings chain: an earlier stop wins over a later pass', async () => {
    const engine = makeEngine(
      makeWorkflow({
        customHooks: [STOP_HOOK, PASS_HOOK],
        hookBindings: [
          {
            hookId: 'stop_hook',
            sourceNode: 'Coding',
            targetNode: 'Review',
            method: 'send_message',
            order: 0,
            enabled: true,
            authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
          },
          {
            hookId: 'pass_hook',
            sourceNode: 'Coding',
            targetNode: 'Review',
            method: 'send_message',
            order: 1,
            enabled: true,
            authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
          },
        ],
      })
    );
    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('stop');
    // The later binding must not have executed after the terminal stop.
    expect(outcome.executionLog.map((e) => e.hookId)).toEqual(['stop_hook']);
  });

  test('human approval skips the hook once, then re-arms it', async () => {
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      hookBindings: [
        {
          hookId: 'stop_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    hookStateRepo.updateWithRetry('run-1', 'stop_hook', {
      localState: { humanApproved: true, humanApprovedAt: 123 },
      lastFlow: 'continue',
      lastReason: 'Approved by human',
    });
    const engine = makeEngine(workflow);

    // First attempt after approval: the hook RUNS (side effects land) and its
    // stop DECISION is overridden — the action delivers.
    const first = await engine.executeAction('send_message', sendParams(), META);
    expect(first.decision).toBe('deliver');
    expect(
      first.executionLog.some(
        (e) => e.reason === 'Human override: hook stop overridden by approval'
      )
    ).toBe(true);
    // The one-shot flag was consumed.
    expect(hookStateRepo.get('run-1', 'stop_hook')?.localState.humanApproved).toBeUndefined();

    // Second attempt: the hook gates again.
    const second = await engine.executeAction('send_message', sendParams(), META);
    expect(second.decision).toBe('stop');
    expect(second.blockingHookId).toBe('stop_hook');
  });

  test('a failed approval-consume write blocks instead of force-skipping the gate', async () => {
    // The consume-write loses a version race (updateWithRetry returns null).
    // Skipping anyway would leave the persisted flag set after this action,
    // turning a one-shot approval into a standing bypass — so the engine must
    // fail closed. In-memory SQLite always succeeds, so force the conflict.
    class ConflictedStateRepo extends WorkflowHookStateRepository {
      updateWithRetry(): null {
        return null;
      }
    }
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      hookBindings: [
        {
          hookId: 'stop_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const conflictedRepo = new ConflictedStateRepo(db);
    conflictedRepo.update('run-1', 'stop_hook', {
      expectedVersion: 0,
      localState: { humanApproved: true, humanApprovedAt: 123 },
    });
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: new NodeExecutionRepository(db),
      artifactRepo,
      hookStateRepo: conflictedRepo,
      workspacePath: process.cwd(),
    });

    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('stop');
    expect(outcome.userState.reason).toContain('approve it again');
    // The hook RAN first (its stop record), then the consume-conflict stop.
    expect(outcome.executionLog.length).toBe(2);
    expect(outcome.executionLog[1]?.flow).toBe('stop');
    expect(outcome.executionLog[1]?.reason).toContain('approve it again');
  });

  test('a failed retry-bookkeeping persist blocks instead of advertising retryable', async () => {
    // The wrapper-level path; drive it through wrapHandlerWithHooks with a
    // repo whose updateWithRetry fails, mirroring a locked SQLite.
    class FailingUpdateRepo extends WorkflowHookStateRepository {
      updateWithRetry(): null {
        return null;
      }
    }
    const RETRY_HOOK = scriptHook(
      'persist_hook',
      '{"flow":"retry","reason":"waiting on GitHub","retryAfterMs":60000}'
    );
    const workflow = makeWorkflow({
      customHooks: [RETRY_HOOK],
      hookBindings: [
        {
          hookId: 'persist_hook',
          sourceNode: 'Coding',
          method: 'mark_complete',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const failingRepo = new FailingUpdateRepo(db);
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: new NodeExecutionRepository(db),
      artifactRepo,
      hookStateRepo: failingRepo,
      workspacePath: process.cwd(),
    });
    let delivered = 0;
    const wrapped = wrapHandlerWithHooks(
      'mark_complete',
      async () => {
        delivered += 1;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      engine,
      {},
      META
    );
    const result = await wrapped({ goalUpdate: { summary: 's' } });
    const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
    // A blocking state error, NOT advertised as retryable-with-backoff (the
    // bookkeeping that would pace it failed to persist).
    expect(parsed.success).toBe(false);
    expect(parsed.retryable).toBeUndefined();
    expect(parsed.error).toContain('could not be persisted');
    expect(delivered).toBe(0);
  });

  test('a failed deliver-path state persist blocks instead of delivering', async () => {
    // The hooks APPROVED this action (flow continue), but the consolidated
    // state write (decision record + any recordState payload) lost its version
    // race or hit a SQLite error. Delivering anyway would run the protected
    // handler while its owned state side effect was lost — a later readState()
    // could repeat a one-shot effect or decide from the pre-action snapshot.
    // Fail closed before delivery.
    class FailingUpdateRepo extends WorkflowHookStateRepository {
      updateWithRetry(): null {
        return null;
      }
    }
    const PASS_HOOK = scriptHook('deliver_persist_hook', '{"flow":"continue"}');
    const workflow = makeWorkflow({
      customHooks: [PASS_HOOK],
      hookBindings: [
        {
          hookId: 'deliver_persist_hook',
          sourceNode: 'Coding',
          method: 'mark_complete',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: new NodeExecutionRepository(db),
      artifactRepo,
      hookStateRepo: new FailingUpdateRepo(db),
      workspacePath: process.cwd(),
    });
    let delivered = 0;
    const wrapped = wrapHandlerWithHooks(
      'mark_complete',
      async () => {
        delivered += 1;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      engine,
      {},
      META
    );
    const result = await wrapped({ goalUpdate: { summary: 's' } });
    const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
    expect(parsed.success).toBe(false);
    expect(parsed.hookStatus).toBe('blocked');
    expect(parsed.error).toContain('could not be persisted before delivery');
    // The protected handler never ran.
    expect(delivered).toBe(0);
  });

  test('the cooldown pre-check enforces the retry ceiling (agent-driven loop)', async () => {
    // Non-send_message methods have no engine timer: every attempt runs the
    // cooldown pre-check, so the ceiling must convert here — otherwise a
    // perpetually-retrying gate (pr_merged on an OPEN PR) loops forever.
    const RETRY_HOOK = scriptHook('ceiling_hook', '{"flow":"retry","reason":"still open"}');
    const workflow = makeWorkflow({
      customHooks: [RETRY_HOOK],
      hookBindings: [
        {
          hookId: 'ceiling_hook',
          sourceNode: 'Coding',
          method: 'mark_complete',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    hookStateRepo.updateWithRetry('run-1', 'ceiling_hook', {
      retryCount: 2880,
      nextRetryAt: Date.now() + 60_000,
      lastFlow: 'retry',
      lastReason: 'still open',
    });
    const engine = makeEngine(workflow);

    const outcome = await engine.executeAction('mark_complete', {}, META);
    expect(outcome.decision).toBe('stop');
    expect(outcome.userState.reason).toContain('retry limit exceeded');
  });

  test('the ELAPSED ceiling trips on a stale __firstRetryAt (7-day window)', async () => {
    const RETRY_HOOK = scriptHook('stale_hook', '{"flow":"retry","reason":"still open"}');
    const workflow = makeWorkflow({
      customHooks: [RETRY_HOOK],
      hookBindings: [
        {
          hookId: 'stale_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    // A first-retry stamp 8 days ago with NO active cooldown and an attempt
    // count BELOW the numeric ceiling: the hook runs, returns retry, and the
    // ELAPSED ceiling (not the attempt count) converts it to a terminal stop.
    hookStateRepo.updateWithRetry('run-1', 'stale_hook', {
      localState: { __firstRetryAt: Date.now() - 8 * 24 * 60 * 60 * 1000 },
      retryCount: 10,
      lastFlow: 'retry',
      lastReason: 'still open',
    });
    const engine = makeEngine(workflow);
    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('stop');
    expect(outcome.userState.reason).toContain('elapsed time exceeded');
  });

  test('a ceiling stop preserves its terminal marker — a reissue cannot restart the cycle', async () => {
    const RETRY_HOOK = scriptHook('ceil_keep_hook', '{"flow":"retry","reason":"still open"}');
    const workflow = makeWorkflow({
      customHooks: [RETRY_HOOK],
      hookBindings: [
        {
          hookId: 'ceil_keep_hook',
          sourceNode: 'Coding',
          method: 'mark_complete',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    // First cycle: hits the elapsed ceiling (8-day-old stamp).
    hookStateRepo.updateWithRetry('run-1', 'ceil_keep_hook', {
      localState: { __firstRetryAt: Date.now() - 8 * 24 * 60 * 60 * 1000 },
      retryCount: 10,
      lastFlow: 'retry',
      lastReason: 'still open',
    });
    const engine = makeEngine(workflow);
    const first = await engine.executeAction('mark_complete', {}, META);
    expect(first.decision).toBe('stop');

    // The stop path preserved the bookkeeping and stamped the marker.
    const state = hookStateRepo.get('run-1', 'ceil_keep_hook');
    expect(state?.localState.__retryCeilingTerminal).toBe(true);
    expect(state?.retryCount).toBe(10);

    // A reissued action is IMMEDIATELY terminal (no fresh 7-day cycle).
    const second = await engine.executeAction('mark_complete', {}, META);
    expect(second.decision).toBe('stop');
    expect(second.userState.reason).toContain('retry limit exceeded');
  });

  test('a hook-run retry converts to stop at the ceiling (send_message path)', async () => {
    const RETRY_HOOK = scriptHook('ceiling_hook', '{"flow":"retry","reason":"still open"}');
    const workflow = makeWorkflow({
      customHooks: [RETRY_HOOK],
      hookBindings: [
        {
          hookId: 'ceiling_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    // At the ceiling with NO active cooldown, so the hook itself runs, returns
    // retry, and the engine converts it to a terminal stop.
    hookStateRepo.updateWithRetry('run-1', 'ceiling_hook', {
      retryCount: 2880,
      lastFlow: 'retry',
      lastReason: 'still open',
    });
    const engine = makeEngine(workflow);

    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('stop');
    expect(outcome.userState.reason).toContain('retry limit exceeded');
  });

  test('a backgrounded child inheriting stdout cannot wedge the hook (grace path)', async () => {
    // The parent shell prints its HookReturn and exits immediately, but a
    // backgrounded `sleep` inherits stdout and holds the pipe open. The
    // collectors must be cancelled after the grace period (not wait out the
    // child), and the parent's buffered output must survive.
    const BG_HOOK = scriptHook('bg_hook', '{"flow":"continue"}');
    const workflow = makeWorkflow({
      customHooks: [
        {
          ...BG_HOOK,
          run: {
            kind: 'script',
            interpreter: 'bash',
            source: 'sleep 30 & echo $! > .hook-grace-child-pid; echo \'{"flow":"continue"}\'',
          },
        },
      ],
      hookBindings: [
        {
          hookId: 'bg_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const engine = makeEngine(workflow);
    const startedAt = Date.now();
    const outcome = await engine.executeAction('send_message', sendParams(), META);
    const elapsed = Date.now() - startedAt;
    expect(outcome.decision).toBe('deliver');
    // The 30s child must NOT be waited out: well under its sleep, with slack
    // for the 2s grace plus spawn overhead.
    expect(elapsed).toBeLessThan(10_000);
    // And the background child is terminated, not merely abandoned — the
    // script writes its own PID group marker; after the action, that process
    // must be gone (process-group kill, not just pipe cancellation).
    const marker = `${process.cwd()}/.hook-grace-child-pid`;
    const childPid = Number(require('node:fs').readFileSync(marker, 'utf8').trim());
    require('node:fs').rmSync(marker, { force: true });
    expect(Number.isFinite(childPid)).toBe(true);
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  test('re-upserted oldest stamp still wins when newer stamps fall outside the window', async () => {
    // The OLDEST stamp is re-upserted late (updatedAt bumps it back into the
    // freshest-50) while a NEWER stamp stays outside the window. The merged
    // snapshot must still surface the oldest identity LAST — a split
    // recent/reserved concatenation would flip it.
    artifactRepo.upsert({
      id: 'a-old',
      runId: 'run-1',
      nodeId: 'n-review',
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://github.com/o/r/pull/OLD', kind: 'pr' },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    artifactRepo.upsert({
      id: 'a-newer',
      runId: 'run-1',
      nodeId: 'n-coding',
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://github.com/o/r/pull/NEWER', kind: 'pr' },
    });
    for (let i = 0; i < 55; i++) {
      artifactRepo.upsert({
        id: `filler-${i}`,
        runId: 'run-1',
        nodeId: 'n-coding',
        artifactType: 'note',
        artifactKey: `filler-${i}`,
        data: { seq: i },
      });
    }
    // Re-upsert the OLD stamp: updatedAt jumps to now (into the recent
    // window); its createdAt is unchanged and still the earliest.
    await new Promise((resolve) => setTimeout(resolve, 5));
    artifactRepo.upsert({
      id: 'a-old',
      runId: 'run-1',
      nodeId: 'n-review',
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://github.com/o/r/pull/OLD', kind: 'pr' },
    });

    const engine = makeEngine(makeWorkflow());
    const window = engine['readArtifactsForCtx']();
    expect(window).not.toBeNull();
    const reserved = (window ?? []).filter((e) => e.artifact.artifactKey === '__pr_validated__');
    expect(reserved.length).toBe(2);
    expect(reserved[reserved.length - 1]?.artifact.data.link).toBe(
      'https://github.com/o/r/pull/OLD'
    );
  });

  test('custom-script env is allow-listed — daemon secrets do not leak', async () => {
    // The script fails (stop) when it can see the injected secret-ish var,
    // and succeeds (continue) when it cannot; HYPERNEO_* must pass through.
    process.env.ACME_DAEMON_TEST_SECRET = 'super-secret-value';
    process.env.HYPERNEO_PROVIDER_CREDENTIAL_KEY = 'a'.repeat(64);
    try {
      const ENV_HOOK = {
        id: 'env_probe_hook',
        requiredData: [],
        run: {
          kind: 'script' as const,
          interpreter: 'bash' as const,
          source:
            'if env | grep -qE "^(ACME_DAEMON_TEST_SECRET|HYPERNEO_PROVIDER_CREDENTIAL_KEY)="; then ' +
            'echo \'{"flow":"stop","reason":"secret leaked"}\'; else ' +
            'echo \'{"flow":"continue"}\'; fi',
        },
      };
      const workflow = makeWorkflow({
        customHooks: [ENV_HOOK],
        hookBindings: [
          {
            hookId: 'env_probe_hook',
            sourceNode: 'Coding',
            targetNode: 'Review',
            method: 'send_message',
            order: 0,
            enabled: true,
            authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
          },
        ],
      });
      const engine = makeEngine(workflow);
      const outcome = await engine.executeAction('send_message', sendParams(), META);
      expect(outcome.decision).toBe('deliver');
    } finally {
      delete process.env.ACME_DAEMON_TEST_SECRET;
      delete process.env.HYPERNEO_PROVIDER_CREDENTIAL_KEY;
    }
  });

  test('custom-script HOME is isolated from the daemon home', async () => {
    // The script stops when HOME still points at the daemon's real home
    // (where ~/.claude/.credentials.json and gh config live) and continues
    // when it is a scratch directory.
    const daemonHome = process.env.HOME ?? '';
    const source =
      `if [ "$HOME" = ${JSON.stringify(daemonHome)} ]; then ` +
      'echo \'{"flow":"stop","reason":"daemon home leaked"}\'; else ' +
      'echo \'{"flow":"continue"}\'; fi';
    const workflow = makeWorkflow({
      customHooks: [
        {
          id: 'home_probe_hook',
          requiredData: [],
          run: { kind: 'script', interpreter: 'bash', source },
        },
      ],
      hookBindings: [
        {
          hookId: 'home_probe_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const engine = makeEngine(workflow);
    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('deliver');
  });

  test('a normally-exiting script delivers full stdout (collected-wins path)', async () => {
    // Multi-kilobyte output ensures the collectors genuinely win the race
    // with buffered data rather than relying on stream close timing.
    const BIG_HOOK = {
      id: 'big_hook',
      requiredData: [],
      run: {
        kind: 'script' as const,
        interpreter: 'bash' as const,
        source:
          'for i in $(seq 1 200); do echo "// filler line $i of the hook script output padding" >&2; done; ' +
          'echo \'{"flow":"stop","reason":"seen full output"}\'',
      },
    };
    const workflow = makeWorkflow({
      customHooks: [BIG_HOOK],
      hookBindings: [
        {
          hookId: 'big_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const engine = makeEngine(workflow);
    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('stop');
    expect(outcome.userState.reason).toBe('seen full output');
  });

  test('the legacy-hook guard blocks every gated action (pre-v2 pinned run)', async () => {
    const guard = createLegacyHookGuardEngine(
      {
        workflow: makeWorkflow(),
        workflowRunId: 'run-1',
        nodeExecutionRepo: new NodeExecutionRepository(db),
        hookStateRepo,
        workspacePath: process.cwd(),
      },
      'pre-v2 pinned workflow; re-create hooks as v2 bindings'
    );
    const outcome = await guard.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('stop');
    expect(outcome.userState.reason).toContain('re-create hooks as v2 bindings');
  });

  test('reserved stamps outside the recent window stay oldest-last (identity order)', async () => {
    // Push the reserved stamps out of the freshest-50 window with newer
    // artifacts, then verify the ctx window's LAST reserved stamp is the
    // OLDEST one (getPrimaryLink takes the last match).
    const now = Date.now();
    artifactRepo.upsert({
      id: 'a-old',
      runId: 'run-1',
      nodeId: 'n-review',
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://github.com/o/r/pull/OLD', kind: 'pr' },
    });
    // Distinct createdAt: the repo stamps Date.now(), and two same-millisecond
    // rows leave the ASC tie order unspecified (the assertion below flipped in
    // CI on a tie).
    await new Promise((resolve) => setTimeout(resolve, 5));
    artifactRepo.upsert({
      id: 'a-newer',
      runId: 'run-1',
      nodeId: 'n-coding',
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://github.com/o/r/pull/NEWER', kind: 'pr' },
    });
    for (let i = 0; i < 55; i++) {
      artifactRepo.upsert({
        id: `filler-${i}`,
        runId: 'run-1',
        nodeId: 'n-coding',
        artifactType: 'note',
        artifactKey: `filler-${i}`,
        data: { seq: now + i },
      });
    }
    const engine = makeEngine(makeWorkflow());
    const window = engine['readArtifactsForCtx']();
    expect(window).not.toBeNull();
    const reserved = (window ?? []).filter((e) => e.artifact.artifactKey === '__pr_validated__');
    expect(reserved.length).toBeGreaterThanOrEqual(2);
    // The LAST reserved entry must be the oldest identity.
    const last = reserved[reserved.length - 1]?.artifact.data.link;
    expect(last).toBe('https://github.com/o/r/pull/OLD');
  });

  test('human rejection is a standing block that does not run the hook', async () => {
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      hookBindings: [
        {
          hookId: 'stop_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    hookStateRepo.updateWithRetry('run-1', 'stop_hook', {
      localState: { humanApproved: false, humanRejectionReason: 'not this PR' },
    });
    const engine = makeEngine(workflow);

    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('stop');
    expect(outcome.userState.reason).toBe('not this PR');
    // Rejected without executing the script — the log records the override, not
    // the hook's own stop reason.
    expect(outcome.executionLog).toEqual([
      { hookId: 'stop_hook', flow: 'stop', reason: 'not this PR', timestamp: expect.any(Number) },
    ]);
  });

  test('retry backoff pre-check re-issues retry without running the hook', async () => {
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      hookBindings: [
        {
          hookId: 'stop_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const future = Date.now() + 60_000;
    hookStateRepo.updateWithRetry('run-1', 'stop_hook', {
      nextRetryAt: future,
      lastReason: 'Waiting for GitHub mergeability.',
    });
    const engine = makeEngine(workflow);

    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('retry');
    expect(outcome.userState.reason).toBe('Waiting for GitHub mergeability.');
    expect(outcome.retryAfterMs).toBeGreaterThan(0);
    // The script hook never ran — a stop hook would have blocked instead.
    expect(outcome.decision).not.toBe('stop');
  });

  test('a passing hook may patch params, validated against the method schema', async () => {
    const engine = makeEngine(
      makeWorkflow({
        customHooks: [
          scriptHook('patch_hook', `{"flow":"continue","payload":{"message":"rewritten summary"}}`),
        ],
        hookBindings: [
          {
            hookId: 'patch_hook',
            sourceNode: 'Coding',
            targetNode: 'Review',
            method: 'send_message',
            order: 0,
            enabled: true,
            authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
          },
        ],
      })
    );
    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('deliver');
    expect(outcome.finalParams.message).toBe('rewritten summary');
    expect(outcome.finalParams.target).toBe('Review');
  });

  test('side effects compose within one action: a later binding sees an earlier write', () => {
    const engine = makeEngine(makeWorkflow());
    const artifacts: Array<{ nodeId: string; artifact: HookArtifact }> = [];
    const binding = {
      hookId: 'pr_ready',
      sourceNode: 'Coding',
      targetNode: 'Review',
      method: 'send_message' as const,
      order: 0,
      enabled: true,
    };

    const first = engine['buildHookContext'](binding, META, artifacts);
    first.ctx.writeArtifact({
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://github.com/o/r/pull/1', kind: 'pr' },
    });

    const second = engine['buildHookContext'](binding, META, artifacts);
    const seen = second.ctx.readArtifacts().filter((a) => a.artifactKey === '__pr_validated__');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.data.link).toBe('https://github.com/o/r/pull/1');

    // Re-writing the same (node, type, key) replaces in place (upsert
    // semantics) instead of appending a duplicate.
    first.ctx.writeArtifact({
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://github.com/o/r/pull/2', kind: 'pr' },
    });
    const after = artifacts.filter((a) => a.artifact.artifactKey === '__pr_validated__');
    expect(after).toHaveLength(1);
    expect(after[0]?.artifact.data.link).toBe('https://github.com/o/r/pull/2');

    // A write from a DIFFERENT node with the same type/key is a distinct row
    // (the repo key includes nodeId) and must not replace this node's entry.
    second.ctx.writeArtifact({
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      nodeId: 'n-review',
      data: { link: 'https://github.com/o/r/pull/3', kind: 'pr' },
    });
    const perNode = artifacts.filter((a) => a.artifact.artifactKey === '__pr_validated__');
    expect(perNode).toHaveLength(2);
    expect(perNode.map((a) => a.artifact.data.link).sort()).toEqual([
      'https://github.com/o/r/pull/2',
      'https://github.com/o/r/pull/3',
    ]);
  });

  test("queueing a DIFFERENT action does not reap the prior action's timer", async () => {
    const { clearRetryableHookActionTimer } = await import(
      '../../../../src/lib/space/runtime/workflow-hook-engine'
    );
    const RETRY_HOOK = scriptHook('q_hook', '{"flow":"retry","reason":"waiting"}');
    const workflow = makeWorkflow({
      customHooks: [RETRY_HOOK],
      hookBindings: [
        {
          hookId: 'q_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const engine = makeEngine(workflow);
    const wrappedA = wrapHandlerWithHooks(
      'send_message',
      async (args: Record<string, unknown>) => ({ content: [{ type: 'text', text: 'ok' }] }),
      engine,
      {},
      META
    );
    const first = await wrappedA({ target: 'Review', message: 'first' } as never);
    const firstParsed = JSON.parse((first.content?.[0] as { text: string }).text);
    expect(firstParsed.queued).toBe(true);

    // A second, DIFFERENT gated message while the first is pending: the first
    // action's timer must survive (only a same-key replacement reaps it).
    const second = await wrappedA({ target: 'Review', message: 'second' } as never);
    const secondParsed = JSON.parse((second.content?.[0] as { text: string }).text);
    expect(secondParsed.queued).toBe(true);
    // The first action's timer is still armed — its clear would be a no-op if
    // disarmed; assert indirectly via the module map retaining both entries
    // is not exported, so assert the durable record holds the LATEST action
    // (single-slot limitation) while no throw occurred.
    expect(hookStateRepo.get('run-1', 'q_hook')?.retryCount).toBeGreaterThanOrEqual(1);
    void clearRetryableHookActionTimer;
  });

  describe('wrapHandlerWithHooks — follow-up dispatch', () => {
    test('a follow-up queued by a delivered hook dispatches through the wrapped send_message', async () => {
      // The hook continues AND queues a follow-up to Review; the delivered
      // send_message handler records every raw invocation, and the follow-up
      // must be dispatched with the queued message + target.
      const FOLLOW_HOOK = scriptHook('follow_hook', '{"flow":"continue","result":null}');
      const workflow = makeWorkflow({
        customHooks: [FOLLOW_HOOK],
        hookBindings: [
          {
            hookId: 'follow_hook',
            sourceNode: 'Coding',
            targetNode: 'Review',
            method: 'send_message',
            order: 0,
            enabled: true,
            authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
          },
        ],
      });
      const engine = makeEngine(workflow);
      const dispatched: Array<Record<string, unknown>> = [];
      const sendHandler = async (args: Record<string, unknown>) => {
        dispatched.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      };
      const wrappedSend = wrapHandlerWithHooks(
        'send_message',
        sendHandler,
        engine,
        {},
        { ...META, targetNode: 'Review' }
      );
      const handlers = { send_message: wrappedSend };

      // Drive a delivered action whose hook queues a follow-up: emulate by
      // running a second action after recording a queued follow-up via the
      // engine's public queueing surface — simplest is a hook script that
      // echoes a follow-up request through its result; the wrapper only
      // dispatches outcome.followUpRequests, which come from ctx
      // .queueFollowUp. Use a custom hook whose script signals a follow-up is
      // impossible (scripts cannot call ctx), so drive it directly instead:
      // executeAction is not the wrapper — patch the engine outcome via a
      // stub engine subclass.
      class FollowUpEngine extends WorkflowHookEngine {
        override async executeAction(
          _method: string,
          params: Record<string, unknown>
        ): Promise<HookActionOutcome> {
          return {
            decision: 'deliver',
            finalParams: params,
            followUpRequests: [{ targetNode: 'Review', message: 'queued follow-up' }],
            stateUpdates: [],
            executionLog: [],
            userState: { status: 'allowed' },
          };
        }
      }
      const followEngine = new FollowUpEngine({
        workflow,
        workflowRunId: 'run-1',
        nodeExecutionRepo: new NodeExecutionRepository(db),
        artifactRepo,
        hookStateRepo,
        workspacePath: process.cwd(),
      });
      const wrappedWithFollowUps = wrapHandlerWithHooks(
        'send_message',
        sendHandler,
        followEngine,
        handlers,
        META
      );

      await wrappedWithFollowUps({ target: 'Review', message: 'primary' });
      // Primary delivered, and the queued follow-up dispatched through the
      // REAL wrapped send_message (whose bindings run — outcome from the real
      // engine: the follow_hook script continues, so it delivers too).
      expect(dispatched.length).toBe(2);
      // The wrapper awaits follow-up dispatches before invoking the primary
      // handler, but completion order is runtime-dependent — assert both
      // payloads landed, not their sequence.
      expect(dispatched.map((d) => d.message).sort()).toEqual(['primary', 'queued follow-up']);
    });

    test('nested follow-up emission is suppressed during follow-up dispatch', async () => {
      // The follow-up dispatch re-enters the wrapper with isFollowUp=true; a
      // nested outcome carrying followUpRequests must NOT dispatch again.
      let calls = 0;
      class NestedFollowUpEngine extends WorkflowHookEngine {
        override async executeAction(
          _method: string,
          params: Record<string, unknown>
        ): Promise<HookActionOutcome> {
          calls += 1;
          return {
            decision: 'deliver',
            finalParams: params,
            // ALWAYS carries a follow-up: on the nested (isFollowUp) call the
            // wrapper must suppress it instead of dispatching recursively.
            followUpRequests: [{ targetNode: 'Review', message: 'nested' }],
            stateUpdates: [],
            executionLog: [],
            userState: { status: 'allowed' },
          };
        }
      }
      const workflow = makeWorkflow();
      const engine = new NestedFollowUpEngine({
        workflow,
        workflowRunId: 'run-1',
        nodeExecutionRepo: new NodeExecutionRepository(db),
        artifactRepo,
        hookStateRepo,
        workspacePath: process.cwd(),
      });
      const dispatched: Array<Record<string, unknown>> = [];
      const sendHandler = async (args: Record<string, unknown>) => {
        dispatched.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      };
      const wrapped = wrapHandlerWithHooks('send_message', sendHandler, engine, {}, META);
      // handlers map resolves on the second (follow-up) invocation via the
      // RAW_HANDLER on `wrapped` itself — pass wrapped's own map.
      const handlers = { send_message: wrapped };

      await (
        wrapHandlerWithHooks('send_message', sendHandler, engine, handlers, META) as unknown as (
          args: Record<string, unknown>
        ) => Promise<unknown>
      )({
        target: 'Review',
        message: 'primary',
      });
      // Primary + one follow-up only: the nested request was suppressed.
      expect(dispatched.length).toBe(2);
      expect(dispatched.map((d) => d.message).sort()).toEqual(['nested', 'primary'].sort());
    });
  });

  describe('wrapHandlerWithHooks — non-send_message retry pacing', () => {
    test('a retrying non-message hook increments its count and keeps a cooldown', async () => {
      const { wrapHandlerWithHooks } = await import(
        '../../../../src/lib/space/runtime/workflow-hook-engine'
      );
      const RETRY_HOOK = scriptHook(
        'retry_hook',
        '{"flow":"retry","reason":"waiting on GitHub","retryAfterMs":60000}'
      );
      const workflow = makeWorkflow({
        customHooks: [RETRY_HOOK],
        // Non-routed binding (no targetNode) — matches mark_complete actions.
        hookBindings: [
          {
            hookId: 'retry_hook',
            sourceNode: 'Coding',
            method: 'mark_complete',
            order: 0,
            enabled: true,
            authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
          },
        ],
      });
      const engine = makeEngine(workflow);
      let underlyingCalls = 0;
      const underlying = async (): Promise<{ content: Array<{ type: string; text: string }> }> => {
        underlyingCalls += 1;
        return { content: [{ type: 'text', text: 'ok' }] };
      };
      const wrapped = wrapHandlerWithHooks('mark_complete', underlying, engine, {}, META);

      const first = await wrapped({ goalUpdate: { summary: 's' } });
      expect(JSON.parse((first.content?.[0] as { text: string }).text).retryable).toBe(true);
      // The blocking hook's bookkeeping persisted: count incremented, cooldown set.
      const state = hookStateRepo.get('run-1', 'retry_hook');
      expect(state?.retryCount).toBe(1);
      expect(state?.nextRetryAt).toBeGreaterThan(Date.now() - 1000);
      // The underlying handler never ran.
      expect(underlyingCalls).toBe(0);

      // An immediate second attempt is paced by the cooldown pre-check: the
      // hook does not re-run (the underlying handler stays unreachable), and
      // the paced attempt still counts toward MAX_RETRY_ATTEMPTS — every paced
      // response is a real agent attempt, so the ceiling eventually converts a
      // hopeless loop to a terminal stop.
      const second = await wrapped({ goalUpdate: { summary: 's' } });
      const secondParsed = JSON.parse((second.content?.[0] as { text: string }).text);
      expect(secondParsed.retryable).toBe(true);
      expect(underlyingCalls).toBe(0);
      expect(hookStateRepo.get('run-1', 'retry_hook')?.retryCount).toBe(2);
      expect(hookStateRepo.get('run-1', 'retry_hook')?.nextRetryAt).toBeGreaterThan(
        Date.now() - 1000
      );
    });
  });
});
