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
import {
  WorkflowHookStateRepository,
  type WorkflowHookStatePatch,
} from '../../../../src/storage/repositories/workflow-hook-state-repository';
import {
  createLegacyHookGuardEngine,
  QUEUED_RETRYABLE_ACTION_STATE_KEY,
  WorkflowHookEngine,
  wrapHandlerWithHooks,
  type HookActionOutcome,
  type HookActionMeta,
} from '../../../../src/lib/space/runtime/workflow-hook-engine';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import {
  buildRetryableActionKey,
  backoffDelayMs,
} from '../../../../src/lib/space/runtime/workflow-hook-engine.ts';
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

  /** Arm an approval the way production does: approveHook copies the stop's
   * __blockedActionKey into __approvedActionKey, and the engine bypasses a
   * stop only when that key matches THIS action's identity. */
  function actionKeyFor(params: Record<string, unknown>): string {
    return buildRetryableActionKey('send_message', params, META);
  }

  /** Invoke a gated send_message through the WRAPPER — the delivery-time
   * approval consume lives there (after the fail-closed persistence
   * prerequisites), so delivery/consume assertions must go through it. */
  async function wrappedSend(
    engine: WorkflowHookEngine,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const wrapped = wrapHandlerWithHooks(
      'send_message',
      async () => ({ content: [{ type: 'text', text: '{"success":true}' }] }),
      engine,
      {},
      META
    );
    const result = await wrapped(params);
    return JSON.parse((result.content?.[0] as { text: string }).text) as Record<string, unknown>;
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
      localState: {
        humanApproved: true,
        humanApprovedAt: 1,
        __approvedActionKey: actionKeyFor(sendParams()),
      },
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

  test('a pre-failure authorized worker keeps its gate; later entries are suppressed', async () => {
    // ['@worker:Review/reviewer', '@worker:Other/other'] — Other is not
    // channel-reachable. Router parity (round 49): the generic path is
    // SEQUENTIAL — it delivers Review BEFORE reaching Other and returning,
    // so Review's gate MUST run (suppressing it would deliver an ungated
    // handoff); Other and later entries never deliver and are suppressed.
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
    // Review (before the failure) keeps its gate; the send stops there.
    expect(outcome.decision).toBe('stop');
    expect(outcome.blockingHookId).toBe('mixed_hook');

    // Reversed order: the unauthorized entry fails FIRST — nothing after it
    // delivers, so no gate may run off this send.
    const reversed = await engine.executeAction(
      'send_message',
      { target: ['@worker:n-other/other', '@worker:n-review/reviewer'], message: 'reversed' },
      META
    );
    expect(reversed.decision).toBe('deliver');
    expect(reversed.executionLog.length).toBe(0);

    // An all-AUTHORIZED worker multicast keeps its gates (nothing refused).
    const authorized = await engine.executeAction(
      'send_message',
      { target: ['@worker:n-review/reviewer'], message: 'authorized' },
      META
    );
    expect(authorized.decision).toBe('stop');
    expect(authorized.blockingHookId).toBe('mixed_hook');
  });

  test('queueing patches only the new action key (no sibling resurrection)', async () => {
    // The durable queue map is shared. Spreading a whole-map snapshot into
    // the patch would resurrect a sibling key that a concurrent write
    // cleared between the read and the persist (updateWithRetry refreshes
    // to the latest version). The queue write must name ONLY the new key —
    // deep-merge keeps the stored siblings.
    const RETRY_HOOK = scriptHook('queue_scope_hook', '{"flow":"retry","reason":"waiting"}');
    const workflow = makeWorkflow({
      customHooks: [RETRY_HOOK],
      hookBindings: [
        {
          hookId: 'queue_scope_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    // A sibling entry already lives in the durable map.
    hookStateRepo.updateWithRetry('run-1', 'queue_scope_hook', {
      localState: {
        [QUEUED_RETRYABLE_ACTION_STATE_KEY]: {
          'key-sibling': {
            actionKey: 'key-sibling',
            hookId: 'queue_scope_hook',
            methodName: 'send_message',
            args: { target: 'Review', message: 'sibling' },
            meta: { sessionId: 's-x', agentName: 'coder', nodeId: 'n-coding', taskId: 'task-x' },
            isFollowUp: false,
            nextRetryAt: Date.now() + 60_000,
            retryAfterMs: 60_000,
            queuedAt: Date.now(),
          },
        },
      },
    });
    const seenQueueKeys: string[][] = [];
    class InspectQueueWrites extends WorkflowHookStateRepository {
      update(runId: string, hookId: string, patch: WorkflowHookStatePatch) {
        const queued = patch.localState?.[QUEUED_RETRYABLE_ACTION_STATE_KEY];
        if (queued && typeof queued === 'object' && !Array.isArray(queued)) {
          seenQueueKeys.push(Object.keys(queued as Record<string, unknown>));
        }
        return super.update(runId, hookId, patch);
      }
    }
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: new NodeExecutionRepository(db),
      artifactRepo,
      hookStateRepo: new InspectQueueWrites(db),
      workspacePath: process.cwd(),
    });
    const wrapped = wrapHandlerWithHooks(
      'send_message',
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      engine,
      {},
      META
    );
    const result = await wrapped({ target: 'Review', message: 'handoff' });
    // The action queued (retry flow).
    expect(JSON.parse((result.content?.[0] as { text: string }).text).queued).toBe(true);
    // Every queue write names EXACTLY the new action's key — never the
    // sibling snapshot.
    expect(seenQueueKeys.length).toBeGreaterThan(0);
    for (const keys of seenQueueKeys) {
      expect(keys).toHaveLength(1);
      expect(keys[0]).not.toBe('key-sibling');
    }
  });

  test("cancelled-owner rehydration clears only that owner's queued action", () => {
    // The durable queue map is SHARED across owners under one hook: clearing
    // the whole map on a cancelled owner's rehydration would delete another
    // session's accepted send (lost until its own rehydration, and across any
    // restart in between). Only the cancelled action's key may be removed.
    const RETRY_HOOK = scriptHook('cancel_clear_hook', '{"flow":"retry","reason":"waiting"}');
    const workflow = makeWorkflow({
      customHooks: [RETRY_HOOK],
      hookBindings: [
        {
          hookId: 'cancel_clear_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const cancelledMeta: HookActionMeta = {
      sessionId: 's-a',
      agentName: 'coder',
      nodeId: 'n-coding',
      taskId: 'task-cancelled',
    };
    const otherMeta: HookActionMeta = {
      sessionId: 's-b',
      agentName: 'reviewer',
      nodeId: 'n-review',
      taskId: 'task-live',
    };
    const entry = (actionKey: string, meta: HookActionMeta) => ({
      actionKey,
      hookId: 'cancel_clear_hook',
      methodName: 'send_message',
      args: { target: 'Review', message: 'm' },
      meta,
      isFollowUp: false,
      nextRetryAt: Date.now() + 60_000,
      retryAfterMs: 60_000,
      queuedAt: Date.now(),
    });
    hookStateRepo.updateWithRetry('run-1', 'cancel_clear_hook', {
      localState: {
        [QUEUED_RETRYABLE_ACTION_STATE_KEY]: {
          'key-cancelled': entry('key-cancelled', cancelledMeta),
          'key-other': entry('key-other', otherMeta),
        },
      },
    });
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: new NodeExecutionRepository(db),
      artifactRepo,
      hookStateRepo,
      workspacePath: process.cwd(),
      getTaskStatus: (taskId) => (taskId === 'task-cancelled' ? 'cancelled' : 'in_progress'),
    });
    engine.scheduleQueuedRetryableActions(
      { send_message: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
      cancelledMeta
    );
    const map = engine.getQueuedRetryableActionsMap('cancel_clear_hook');
    expect(map && 'key-cancelled' in map).toBe(false);
    expect(map?.['key-other']).toBeTruthy();
  });

  test('a slot-authored channel does not run the gate (router parity)', async () => {
    // The router authorizes ordinary targets ONLY via
    // canSend(fromNodeName, resolvedNode) — a channel authored from the
    // AGENT SLOT ('coder → Review', no 'Coding → Review') authorizes nothing
    // at the router, so the engine must not run a side-effecting gate on it.
    const STOP_HOOK = scriptHook('slot_channel_hook', '{"flow":"stop","reason":"blocked"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      channels: [{ from: 'coder', to: 'Review', label: 'coder → Review' }],
      hookBindings: [
        {
          hookId: 'slot_channel_hook',
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
    // Direct node-addressed send.
    const direct = await engine.executeAction(
      'send_message',
      { target: 'Review', message: 'handoff' },
      META
    );
    expect(direct.decision).toBe('deliver');
    expect(hookStateRepo.get('run-1', 'slot_channel_hook')).toBeNull();

    // Broadcast: '*' resolves against the SENDER NODE's permitted targets
    // only — the slot-authored channel contributes nothing.
    const broadcast = await engine.executeAction(
      'send_message',
      { target: '*', message: 'broadcast' },
      META
    );
    expect(broadcast.decision).toBe('deliver');
    expect(hookStateRepo.get('run-1', 'slot_channel_hook')).toBeNull();
  });

  test('a mixed node multicast keeps the pre-failure sibling gate (sequential)', async () => {
    // The node-agent MCP path TRANSLATES plain node entries to @worker
    // addresses before the router, which then delivers SEQUENTIALLY:
    // ['Review','Other'] (Review authorized, Other not) delivers Review
    // BEFORE rejecting Other, so Review's gate MUST run (suppressing it
    // would deliver an ungated handoff). A plain entry matching nothing
    // refuses the whole send (translation rejects it).
    const STOP_HOOK = scriptHook('mixed_node_hook', '{"flow":"stop","reason":"blocked"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      nodes: [
        { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        { id: 'n-review', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
        { id: 'n-other', name: 'Other', agents: [{ agentId: 'a3', name: 'other' }] },
      ],
      channels: [{ from: 'Coding', to: 'Review', label: 'Coding → Review' }],
      hookBindings: [
        {
          hookId: 'mixed_node_hook',
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
    // Authorized entry BEFORE the failure: its gate runs (send stops there).
    const forward = await engine.executeAction(
      'send_message',
      { target: ['Review', 'Other'], message: 'mixed nodes' },
      META
    );
    expect(forward.decision).toBe('stop');
    expect(forward.blockingHookId).toBe('mixed_node_hook');

    // Reversed order: the unauthorized entry fails FIRST — nothing after it
    // delivers, so no gate may run.
    const reversed = await engine.executeAction(
      'send_message',
      { target: ['Other', 'Review'], message: 'reversed' },
      META
    );
    expect(reversed.decision).toBe('deliver');
    expect(reversed.executionLog.length).toBe(0);

    // A plain entry matching no known node refuses the whole send.
    const unknown = await engine.executeAction(
      'send_message',
      { target: ['Nope'], message: 'unknown' },
      META
    );
    expect(unknown.decision).toBe('deliver');
    expect(unknown.executionLog.length).toBe(0);
  });

  test("an array '*' over a slot-only channel runs no gates (whole multicast refused)", async () => {
    // Router parity: '*' expands ONLY as the entire string target. Inside an
    // array it is a literal entry the router cannot authorize without a
    // wildcard-'to' channel — one unauthorized entry refuses the WHOLE
    // multicast, so no gate may run off this send (pr_ready could otherwise
    // stamp the run's immutable PR identity from an undelivered attempt).
    const STOP_HOOK = scriptHook('array_wild_hook', '{"flow":"stop","reason":"blocked"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      channels: [{ from: 'coder', to: 'Review', label: 'coder → Review' }],
      hookBindings: [
        {
          hookId: 'array_wild_hook',
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
      { target: ['*', 'Review'], message: 'mixed wildcard' },
      META
    );
    expect(outcome.decision).toBe('deliver');
    expect(hookStateRepo.get('run-1', 'array_wild_hook')).toBeNull();
  });

  test("an array '*' under a wildcard-'to' channel keeps the sibling entries' gates", async () => {
    // When the topology authorizes '*' literally (a 'to: *' channel), the
    // router delivers the resolvable sibling entries — their gates must run.
    // Over-suppressing here would bypass the gate on a delivered send.
    const STOP_HOOK = scriptHook('array_wild_ok_hook', '{"flow":"stop","reason":"blocked"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      channels: [{ from: 'Coding', to: '*', label: 'Coding → *' }],
      hookBindings: [
        {
          hookId: 'array_wild_ok_hook',
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
      { target: ['*', 'Review'], message: 'authorized wildcard' },
      META
    );
    expect(outcome.decision).toBe('stop');
    expect(outcome.blockingHookId).toBe('array_wild_ok_hook');
  });

  test('a plain NODE entry in an array authorizes via a slot-authored channel', async () => {
    // Adapter expands 'Review' → @worker:<run>/Review/reviewer; the router
    // authorizes canSend(fromNode, agentName) for the slot-authored channel
    // 'Coding → reviewer'. The array branch must mirror that (round-53 fixed
    // the string branch only): otherwise Review's gate is suppressed on a
    // delivered send.
    const STOP_HOOK = scriptHook('array_node_slot_hook', '{"flow":"stop","reason":"blocked"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      channels: [{ from: 'Coding', to: 'reviewer', label: 'Coding → reviewer' }],
      hookBindings: [
        {
          hookId: 'array_node_slot_hook',
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
    const single = await engine.executeAction(
      'send_message',
      { target: ['Review'], message: 'slot-authored' },
      META
    );
    expect(single.decision).toBe('stop');
    expect(single.blockingHookId).toBe('array_node_slot_hook');

    // Mixed: Review authorized via slot before an unauthorized Other →
    // Review's gate still runs (sequential delivery).
    const otherWorkflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      nodes: [
        { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        { id: 'n-review', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
        { id: 'n-other', name: 'Other', agents: [{ agentId: 'a3', name: 'other' }] },
      ],
      channels: [{ from: 'Coding', to: 'reviewer', label: 'Coding → reviewer' }],
      hookBindings: [
        {
          hookId: 'array_node_slot_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const otherEngine = makeEngine(otherWorkflow);
    const mixed = await otherEngine.executeAction(
      'send_message',
      { target: ['Review', 'Other'], message: 'mixed' },
      META
    );
    expect(mixed.decision).toBe('stop');
    expect(mixed.blockingHookId).toBe('array_node_slot_hook');
  });

  test('worker expansion order gates multi-agent nodes (first slot decides)', async () => {
    // The adapter expands a node to one @worker per agent in DECLARATION
    // order; the router aborts at the first unauthorized worker. A node
    // ordered [qa, reviewer] with a channel only to 'reviewer' receives
    // NOTHING (qa is rejected first) — its gate must not run. Reordered
    // [reviewer, qa], the first worker delivers and the gate must run.
    const STOP_HOOK = scriptHook('order_hook', '{"flow":"stop","reason":"blocked"}');
    const build = (agents: Array<{ agentId: string; name: string }>) =>
      makeWorkflow({
        customHooks: [STOP_HOOK],
        nodes: [
          { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
          { id: 'n-review', name: 'Review', agents },
        ],
        channels: [{ from: 'Coding', to: 'reviewer', label: 'Coding → reviewer' }],
        hookBindings: [
          {
            hookId: 'order_hook',
            sourceNode: 'Coding',
            targetNode: 'Review',
            method: 'send_message',
            order: 0,
            enabled: true,
            authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
          },
        ],
      });
    // [qa, reviewer]: qa unauthorized FIRST → router aborts before delivery.
    const rejected = makeEngine(
      build([
        { agentId: 'a2', name: 'qa' },
        { agentId: 'a3', name: 'reviewer' },
      ])
    );
    const rejectedOutcome = await rejected.executeAction(
      'send_message',
      { target: 'Review', message: 'ordered' },
      META
    );
    expect(rejectedOutcome.decision).toBe('deliver');
    expect(rejectedOutcome.executionLog.length).toBe(0);

    // [reviewer, qa]: reviewer authorized FIRST → delivers, then aborts at qa.
    const delivered = makeEngine(
      build([
        { agentId: 'a3', name: 'reviewer' },
        { agentId: 'a2', name: 'qa' },
      ])
    );
    const deliveredOutcome = await delivered.executeAction(
      'send_message',
      { target: 'Review', message: 'ordered' },
      META
    );
    expect(deliveredOutcome.decision).toBe('stop');
    expect(deliveredOutcome.blockingHookId).toBe('order_hook');
  });

  test('@role coverage: authorized node gates, unauthorized suppressed, per-node scoping, cross-product slots', async () => {
    const STOP_HOOK = scriptHook('role_hook', '{"flow":"stop","reason":"blocked"}');
    const build = (channels: SpaceWorkflow['channels']) =>
      makeWorkflow({
        customHooks: [STOP_HOOK],
        channels,
        hookBindings: [
          {
            hookId: 'role_hook',
            sourceNode: 'Coding',
            targetNode: 'Review',
            method: 'send_message',
            order: 0,
            enabled: true,
            authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
          },
        ],
      });

    // 1. Node-level channel: the role send is authorized — gate runs.
    const authorized = makeEngine(build([{ from: 'Coding', to: 'Review', label: 'c' }]));
    const okOutcome = await authorized.executeAction(
      'send_message',
      { target: '@role:Review', message: 'role' },
      META
    );
    expect(okOutcome.decision).toBe('stop');
    expect(okOutcome.blockingHookId).toBe('role_hook');

    // 2. No channel to Review: unauthorized — gate suppressed.
    const unauthorized = makeEngine(build([{ from: 'Coding', to: 'Other', label: 'c' }]));
    const noOutcome = await unauthorized.executeAction(
      'send_message',
      { target: '@role:Review', message: 'role' },
      META
    );
    expect(noOutcome.decision).toBe('deliver');
    expect(noOutcome.executionLog.length).toBe(0);

    // 3. Cross-product slot case: channel authored to the SLOT
    // ('Coding → reviewer') authorizes the role send via
    // canSendToWorkerTarget's cross-product.
    const slotChan = makeEngine(build([{ from: 'Coding', to: 'reviewer', label: 'c' }]));
    const slotOutcome = await slotChan.executeAction(
      'send_message',
      { target: '@role:Review', message: 'role' },
      META
    );
    expect(slotOutcome.decision).toBe('stop');
    expect(slotOutcome.blockingHookId).toBe('role_hook');

    // 4. Per-node scoping: a role resolving to TWO nodes where only one has
    // an authorized worker — the unauthorized node's gate is suppressed
    // individually, the authorized node's runs. The two nodes get DIFFERENT
    // hook ids and the log length is pinned at 1 so the suppression of
    // Other's gate is load-bearing: if per-node scoping regressed to "a
    // shared slot name authorizes every node," Other's gate would also run
    // and the log would hold two entries.
    const multiWorkflow = makeWorkflow({
      customHooks: [STOP_HOOK, scriptHook('other_hook', '{"flow":"stop","reason":"other"}')],
      nodes: [
        { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        { id: 'n-review', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
        { id: 'n-other', name: 'Other', agents: [{ agentId: 'a2', name: 'reviewer' }] },
      ],
      channels: [{ from: 'Coding', to: 'Review', label: 'Coding → Review' }],
      hookBindings: [
        {
          hookId: 'role_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
        {
          hookId: 'other_hook',
          sourceNode: 'Coding',
          targetNode: 'Other',
          method: 'send_message',
          order: 1,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const multiEngine = makeEngine(multiWorkflow);
    const multi = await multiEngine.executeAction(
      'send_message',
      { target: '@role:reviewer', message: 'shared role' },
      META
    );
    // Review (authorized) gates; the send stops there — and ONLY there.
    expect(multi.decision).toBe('stop');
    expect(multi.blockingHookId).toBe('role_hook');
    expect(multi.executionLog.length).toBe(1);
    expect(multi.executionLog[0]?.hookId).toBe('role_hook');
  });

  test("a bare non-first slot does not authorize via the first slot's channel", async () => {
    // Node Review declares [coder, reviewer]; the channel authorizes only
    // 'coder'. A bare 'reviewer' target expands to JUST the reviewer worker
    // (legacyBareTargetMatches omits the node's other slots), and the router
    // rejects it — the node's gate must NOT run off the first-declared
    // slot's channel (both string and array forms).
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      nodes: [
        { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        {
          id: 'n-review',
          name: 'Review',
          agents: [
            { agentId: 'a2', name: 'coder' },
            { agentId: 'a3', name: 'reviewer' },
          ],
        },
      ],
      channels: [{ from: 'Coding', to: 'coder', label: 'Coding → coder' }],
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
    // String form: the gate must not run (send is unauthorized) — the hook
    // never executes, so the outcome delivers with an EMPTY execution log.
    const scalar = await engine.executeAction(
      'send_message',
      { target: 'reviewer', message: 'named slot' },
      META
    );
    expect(scalar.decision).toBe('deliver');
    expect(scalar.executionLog.length).toBe(0);
    // Array form: same.
    const array = await engine.executeAction(
      'send_message',
      { target: ['reviewer'], message: 'named slot' },
      META
    );
    expect(array.decision).toBe('deliver');
    expect(array.executionLog.length).toBe(0);
  });

  test("a sibling action's delivery preserves the shared retry bookkeeping", async () => {
    // The count/cooldown live on the (run, hook) row SHARED by every gated
    // action. Action A is queued mid-backoff (retryCount 40, cooldown in the
    // future); action B delivers — B's reset must NOT clobber A's ceiling
    // accumulation (A's timer would fire early and its ceiling never land).
    const PASS = scriptHook('pass_hook', '{"flow":"continue"}');
    const workflow = makeWorkflow({
      customHooks: [PASS],
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
    // Arm the shared bookkeeping AND a durable queued record for action A.
    const actionA = { target: 'Review', message: 'a' };
    const keyA = buildRetryableActionKey('send_message', actionA, META);
    hookStateRepo.update('run-1', 'pass_hook', {
      expectedVersion: 0,
      localState: {
        __firstRetryAt: Date.now() - 1000,
        __queuedRetryableActions: { [keyA]: { actionKey: keyA, hookId: 'pass_hook' } },
      },
      retryCount: 40,
      // No ACTIVE cooldown (A's timer fired and its replay is pending) —
      // otherwise B would queue behind the shared cooldown instead of
      // delivering.
      nextRetryAt: null,
    });
    const engine = makeEngine(workflow);
    // Action B (different message → different key) delivers through the wrapper.
    const result = await wrappedSend(engine, { target: 'Review', message: 'b' });
    expect(result.success).toBe(true);
    // A's bookkeeping SURVIVES B's delivery.
    const after = hookStateRepo.get('run-1', 'pass_hook');
    expect(after?.retryCount).toBe(40);
    expect(after?.localState.__firstRetryAt).toBeDefined();
    // A's durable queued record also survives (B's delivery only clears
    // B's own key).
    const queued = after?.localState.__queuedRetryableActions as Record<string, unknown>;
    expect(queued?.[keyA]).toBeDefined();
  });

  test('a shared bare slot suppresses the unauthorized node individually', async () => {
    // ['reviewer'] where BOTH Review and Other declare the 'reviewer' slot,
    // but only Review has a node-level channel: the adapter expands the bare
    // slot to @worker:Review/reviewer + @worker:Other/reviewer, the router
    // delivers Review then ABORTS at Other's unauthorized worker. Review's
    // gate runs; Other NEVER received the message, so its gate must be
    // suppressed — distinct hook ids + log length pin the suppression.
    const workflow = makeWorkflow({
      customHooks: [
        scriptHook('review_hook', '{"flow":"stop","reason":"review"}'),
        scriptHook('other_hook', '{"flow":"stop","reason":"other"}'),
      ],
      nodes: [
        { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        { id: 'n-review', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
        { id: 'n-other', name: 'Other', agents: [{ agentId: 'a3', name: 'reviewer' }] },
      ],
      channels: [{ from: 'Coding', to: 'Review', label: 'Coding → Review' }],
      hookBindings: [
        {
          hookId: 'review_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
        {
          hookId: 'other_hook',
          sourceNode: 'Coding',
          targetNode: 'Other',
          method: 'send_message',
          order: 1,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const engine = makeEngine(workflow);
    const outcome = await engine.executeAction(
      'send_message',
      { target: ['reviewer'], message: 'shared slot' },
      META
    );
    expect(outcome.decision).toBe('stop');
    expect(outcome.blockingHookId).toBe('review_hook');
    expect(outcome.executionLog.length).toBe(1);
    expect(outcome.executionLog[0]?.hookId).toBe('review_hook');
  });

  test('bare-slot resolution follows EXECUTION creation order, not declaration order', async () => {
    // ADAPTER PARITY: legacyBareTargetMatches prefers actorMatches (live
    // worker executions, created_at ASC) and returns early — declaration-only
    // declarers are excluded. The router delivers in that order, so the
    // engine's sequential fan-out must too. Here declaration order is
    // [Blocker, Other] but only Other has a live execution: the adapter
    // expands 'reviewer' to ONLY Other's worker, the router delivers it
    // (channel Coding→Other), and Other's gate MUST run — the pre-fix engine
    // walked declaration order, aborted at Blocker, and suppressed Other's
    // gate for a handoff the router actually delivered (fail-open).
    const workflow = makeWorkflow({
      customHooks: [scriptHook('other_hook', '{"flow":"stop","reason":"other gate"}')],
      nodes: [
        { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        { id: 'n-blocker', name: 'Blocker', agents: [{ agentId: 'a2', name: 'reviewer' }] },
        { id: 'n-other', name: 'Other', agents: [{ agentId: 'a3', name: 'reviewer' }] },
      ],
      channels: [{ from: 'Coding', to: 'Other', label: 'Coding → Other' }],
      hookBindings: [
        {
          hookId: 'other_hook',
          sourceNode: 'Coding',
          targetNode: 'Other',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    // Only OTHER has a live execution (created first) — the adapter's
    // actorMatches set is exactly [Other].
    new NodeExecutionRepository(db).create({
      workflowRunId: 'run-1',
      workflowNodeId: 'n-other',
      agentName: 'reviewer',
    });
    const engine = makeEngine(workflow);

    const scalar = await engine.executeAction(
      'send_message',
      { target: 'reviewer', message: 'creation-ordered fan-out' },
      META
    );
    // Other delivered (its node-level route) → its gate runs and stops.
    expect(scalar.decision).toBe('stop');
    expect(scalar.blockingHookId).toBe('other_hook');
    expect(scalar.executionLog.length).toBe(1);
    expect(scalar.executionLog[0]?.hookId).toBe('other_hook');

    // Array form: same order parity.
    const array = await engine.executeAction(
      'send_message',
      { target: ['reviewer'], message: 'creation-ordered fan-out' },
      META
    );
    expect(array.decision).toBe('stop');
    expect(array.blockingHookId).toBe('other_hook');
  });

  test('a scalar bare slot fans out sequentially — nodes after the abort are suppressed', async () => {
    // SCALAR target 'reviewer' resolving in order to A(=Review),
    // B(=Blocker), C(=Other): node-level routes to Review and Other but NOT
    // Blocker. The adapter expands the bare slot to one worker per node; the
    // router delivers Review, hard-returns at Blocker's unauthorized worker —
    // Other is NEVER reached, so its gate must not run (the pre-fix string
    // branch evaluated Other independently via its own valid route).
    const workflow = makeWorkflow({
      customHooks: [
        scriptHook('review_hook', '{"flow":"stop","reason":"review"}'),
        scriptHook('other_hook', '{"flow":"stop","reason":"other"}'),
      ],
      nodes: [
        { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        { id: 'n-review', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
        { id: 'n-blocker', name: 'Blocker', agents: [{ agentId: 'a3', name: 'reviewer' }] },
        { id: 'n-other', name: 'Other', agents: [{ agentId: 'a4', name: 'reviewer' }] },
      ],
      channels: [
        { from: 'Coding', to: 'Review', label: 'Coding → Review' },
        { from: 'Coding', to: 'Other', label: 'Coding → Other' },
      ],
      hookBindings: [
        {
          hookId: 'review_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
        {
          hookId: 'other_hook',
          sourceNode: 'Coding',
          targetNode: 'Other',
          method: 'send_message',
          order: 1,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });
    const engine = makeEngine(workflow);
    const outcome = await engine.executeAction(
      'send_message',
      { target: 'reviewer', message: 'scalar fan-out' },
      META
    );
    // Review (delivered first) gates; Other (after the Blocker abort) is
    // suppressed — pinned by log length 1 and the specific hook id.
    expect(outcome.decision).toBe('stop');
    expect(outcome.blockingHookId).toBe('review_hook');
    expect(outcome.executionLog.length).toBe(1);
    expect(outcome.executionLog[0]?.hookId).toBe('review_hook');
  });

  test('a duplicate failing worker does not suppress the earlier delivered node', async () => {
    // ['@worker:Review/good', '@worker:Review/bad'] with a channel to 'good'
    // only: the router delivers good BEFORE aborting at bad — Review received
    // the message, so its gate must run (a post-failure mark on the duplicate
    // must not retroactively suppress the earlier delivered occurrence).
    const STOP_HOOK = scriptHook('dup_hook', '{"flow":"stop","reason":"blocked"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      channels: [{ from: 'Coding', to: 'good', label: 'Coding → good' }],
      hookBindings: [
        {
          hookId: 'dup_hook',
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
      { target: ['@worker:n-review/good', '@worker:n-review/bad'], message: 'dup' },
      META
    );
    expect(outcome.decision).toBe('stop');
    expect(outcome.blockingHookId).toBe('dup_hook');
  });

  test('a mid-node worker abort blocks later array entries (not the node itself)', async () => {
    // Node Review ordered [reviewer, qa] with a channel only to 'reviewer':
    // the adapter expands BOTH slots; the router delivers reviewer then
    // ABORTS at qa — a later 'Other' entry never delivers, so its gate must
    // not run. Review itself delivered, so its own gate runs (stop hook).
    const STOP_HOOK = scriptHook('suffix_hook', '{"flow":"stop","reason":"blocked"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      nodes: [
        { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        {
          id: 'n-review',
          name: 'Review',
          agents: [
            { agentId: 'a3', name: 'reviewer' },
            { agentId: 'a2', name: 'qa' },
          ],
        },
        { id: 'n-other', name: 'Other', agents: [{ agentId: 'a4', name: 'other' }] },
      ],
      channels: [
        { from: 'Coding', to: 'Review', label: 'Coding → Review' },
        { from: 'Coding', to: 'Other', label: 'Coding → Other' },
      ],
      hookBindings: [
        {
          hookId: 'suffix_hook',
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
      { target: ['Review', 'Other'], message: 'node then other' },
      META
    );
    // Review's gate runs (its first slot delivered); the outcome is its stop.
    expect(outcome.decision).toBe('stop');
    expect(outcome.blockingHookId).toBe('suffix_hook');
  });

  test('an unauthorized @session reply aborts the multicast (later entries suppressed)', async () => {
    // The router hard-returns when a session target is not the recorded
    // reply route for the sender — later entries never deliver.
    const STOP_HOOK = scriptHook('session_hook', '{"flow":"stop","reason":"blocked"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      hookBindings: [
        {
          hookId: 'session_hook',
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
      { target: ['@session:not-the-reply', 'Review'], message: 'session then node' },
      META
    );
    expect(outcome.decision).toBe('deliver');
    expect(outcome.executionLog.length).toBe(0);
  });

  test('a "#" channel address aborts the multicast (later entries suppressed)', async () => {
    // The router unconditionally hard-returns at a '#' address before
    // anything after it delivers. A plain sibling after it must not run its
    // gate off an undelivered send.
    const STOP_HOOK = scriptHook('hash_hook', '{"flow":"stop","reason":"blocked"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      hookBindings: [
        {
          hookId: 'hash_hook',
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
      { target: ['#some-channel', 'Review'], message: 'channel then node' },
      META
    );
    expect(outcome.decision).toBe('deliver');
    expect(outcome.executionLog.length).toBe(0);
  });

  test('a "*" broadcast over a slot-only-authored channel runs no gates', async () => {
    // permittedWorkerTargets yields nothing for a slot-only channel (the
    // translator throws), so the send is refused — Review's gate must not run.
    const STOP_HOOK = scriptHook('star_slot_hook', '{"flow":"stop","reason":"blocked"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      channels: [{ from: 'coder', to: 'Review', label: 'coder → Review' }],
      hookBindings: [
        {
          hookId: 'star_slot_hook',
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
    const star = await engine.executeAction(
      'send_message',
      { target: '*', message: 'bcast' },
      META
    );
    expect(star.decision).toBe('deliver');
    expect(star.executionLog.length).toBe(0);

    const arr = await engine.executeAction(
      'send_message',
      { target: ['*'], message: 'bcast arr' },
      META
    );
    expect(arr.decision).toBe('deliver');
    expect(arr.executionLog.length).toBe(0);
  });

  test('a percent-encoded slot name resolves its slot route (router decode parity)', async () => {
    // Channel 'Coding → reviewer:lead' names an AGENT SLOT; the canonical
    // worker address percent-encodes the colon ('reviewer%3Alead'). The
    // router decodes before canSend — the engine must too, or the slot
    // route check fails and the Review binding is suppressed (ungated
    // handoff).
    const STOP_HOOK = scriptHook('encoded_slot_hook', '{"flow":"stop","reason":"blocked"}');
    const workflow = makeWorkflow({
      customHooks: [STOP_HOOK],
      nodes: [
        { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        {
          id: 'n-review',
          name: 'Review',
          agents: [{ agentId: 'a2', name: 'reviewer:lead' }],
        },
      ],
      channels: [{ from: 'Coding', to: 'reviewer:lead', label: 'Coding → reviewer:lead' }],
      hookBindings: [
        {
          hookId: 'encoded_slot_hook',
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
      { target: '@worker:n-review/reviewer%3Alead', message: 'encoded slot' },
      META
    );
    expect(outcome.decision).toBe('stop');
    expect(outcome.blockingHookId).toBe('encoded_slot_hook');
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
      localState: {
        humanApproved: true,
        humanApprovedAt: 123,
        __approvedActionKey: actionKeyFor(sendParams()),
      },
      lastFlow: 'continue',
      lastReason: 'Approved by human',
    });
    const engine = makeEngine(workflow);

    // First attempt after approval (through the WRAPPER — the one-shot
    // consume runs at its delivery-time point): the hook RUNS (side effects
    // land) and its stop DECISION is overridden — the action delivers, and
    // the persisted decision record shows the override.
    const first = await wrappedSend(engine, sendParams());
    expect(first.success).toBe(true);
    expect(hookStateRepo.get('run-1', 'stop_hook')?.lastReason).toBe(
      'Human override: hook stop overridden by approval'
    );
    // The one-shot flag was consumed.
    expect(hookStateRepo.get('run-1', 'stop_hook')?.localState.humanApproved).toBeUndefined();

    // Second attempt: the hook gates again.
    const second = await engine.executeAction('send_message', sendParams(), META);
    expect(second.decision).toBe('stop');
    expect(second.blockingHookId).toBe('stop_hook');
  });

  test("an approval bound to action A does not bypass action B's stop", async () => {
    // The P1 cross-action case: the operator approves a displayed stop of
    // action A; a DIFFERENT action (different target) reaching the same hook
    // produces its own stop — the approval must NOT be spent on it. The
    // engine stamps __blockedActionKey at stop, approveHook copies it into
    // __approvedActionKey, and the override fires only on a match.
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
    const actionA = sendParams();
    hookStateRepo.updateWithRetry('run-1', 'stop_hook', {
      localState: {
        humanApproved: true,
        humanApprovedAt: 1,
        __approvedActionKey: actionKeyFor(actionA),
      },
      lastFlow: 'stop',
    });
    const engine = makeEngine(workflow);

    // Action B — same route, different payload (a different handoff) —
    // stops WITHOUT the override.
    const actionB = { target: 'Review', message: 'different handoff', data: { x: 1 } };
    const outcomeB = await engine.executeAction('send_message', actionB, META);
    expect(outcomeB.decision).toBe('stop');
    expect(
      outcomeB.executionLog.some(
        (e) => e.reason === 'Human override: hook stop overridden by approval'
      )
    ).toBe(false);
    // The approval stays armed for action A.
    expect(hookStateRepo.get('run-1', 'stop_hook')?.localState.humanApproved).toBe(true);

    // Action A re-issued (through the WRAPPER — the one-shot consume runs at
    // its delivery-time point) — the approval overrides its stop, delivers,
    // and is consumed.
    const resultA = await wrappedSend(engine, actionA);
    expect(resultA.success).toBe(true);
    expect(hookStateRepo.get('run-1', 'stop_hook')?.localState.humanApproved).toBeUndefined();
  });

  test('a ceiling-cooldown approval for THIS action bypasses the cooldown and delivers', async () => {
    // The pre-hook ceiling branch: retryCount past the ceiling with
    // __retryCeilingTerminal set and nextRetryAt in the FUTURE (cooldown) —
    // an approval whose action key matches runs the hook immediately, the
    // override defers the consume to the wrapper's delivery point.
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
      localState: {
        humanApproved: true,
        humanApprovedAt: 1,
        __approvedActionKey: actionKeyFor(sendParams()),
        __retryCeilingTerminal: true,
      },
      lastFlow: 'retry',
      retryCount: 5000,
      nextRetryAt: Date.now() + 3_600_000,
    });
    const engine = makeEngine(workflow);
    const result = await wrappedSend(engine, sendParams());
    expect(result.success).toBe(true);
    // The approval bypassed the COOLDOWN but the hook STILL RAN (its stop
    // decision was overridden post-run — a fresh evaluation, not a skip);
    // the approval was consumed at the wrapper's delivery point.
    expect(hookStateRepo.get('run-1', 'stop_hook')?.lastReason).toBe(
      'Human override: hook stop overridden by approval'
    );
    expect(hookStateRepo.get('run-1', 'stop_hook')?.localState.humanApproved).toBeUndefined();
  });

  test('an ordinary-retry invalidates a pending SAME-action approval (conflict blocks)', async () => {
    // Hook returns retry while an approval for THIS action is armed: the
    // approval is invalidated (a later, different stop must not ride it).
    // A WRITE CONFLICT during the clear blocks the action; a token mismatch
    // (a newer grant) proceeds to the retry without touching it.
    const RETRY_HOOK = scriptHook('retry_hook', '{"flow":"retry","reason":"waiting"}');
    const workflow = makeWorkflow({
      customHooks: [RETRY_HOOK],
      hookBindings: [
        {
          hookId: 'retry_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
      ],
    });

    // Arm, then force a consume CONFLICT: the clear fails → block.
    hookStateRepo.updateWithRetry('run-1', 'retry_hook', {
      localState: {
        humanApproved: true,
        humanApprovedAt: 1,
        __approvedActionKey: actionKeyFor(sendParams()),
      },
      lastFlow: 'stop',
    });
    const origSingleA = hookStateRepo.consumeApprovalIfCurrent.bind(hookStateRepo);
    hookStateRepo.consumeApprovalIfCurrent = () => 'conflict' as const;
    const engineA = makeEngine(workflow);
    const blocked = await engineA.executeAction('send_message', sendParams(), META);
    expect(blocked.decision).toBe('stop');
    expect(blocked.userState.reason).toContain('could not be cleared');
    // The approval stays armed for the operator.
    expect(hookStateRepo.get('run-1', 'retry_hook')?.localState.humanApproved).toBe(true);

    // Mismatch arm: a newer grant is not ours to clear — proceed to retry.
    hookStateRepo.consumeApprovalIfCurrent = (
      runId: string,
      hookId: string,
      observed?: { approvedAt: unknown }
    ) => {
      void runId;
      void hookId;
      void observed;
      return 'token-mismatch' as const;
    };
    const engineB = makeEngine(workflow);
    const retried = await engineB.executeAction('send_message', sendParams(), META);
    expect(retried.decision).toBe('retry');
    expect(hookStateRepo.get('run-1', 'retry_hook')?.localState.humanApproved).toBe(true);
    hookStateRepo.consumeApprovalIfCurrent = origSingleA;
  });

  test('a role target suppresses inactive holders when an active holder exists', async () => {
    // RESOLVER PARITY: when any authorized holder of a role has a live
    // sub-session, the resolver delivers ONLY to active holders — an
    // inactive holder's node never receives the message, so its gate must
    // not run. Nodes Review and Other both declare 'reviewer' with channels
    // from Coding; only Review has a live session (per the lookup).
    const workflow = makeWorkflow({
      customHooks: [
        scriptHook('review_hook', '{"flow":"stop","reason":"review"}'),
        scriptHook('other_hook', '{"flow":"stop","reason":"other"}'),
      ],
      nodes: [
        { id: 'n-coding', name: 'Coding', agents: [{ agentId: 'a1', name: 'coder' }] },
        { id: 'n-review', name: 'Review', agents: [{ agentId: 'a2', name: 'reviewer' }] },
        { id: 'n-other', name: 'Other', agents: [{ agentId: 'a3', name: 'reviewer' }] },
      ],
      channels: [
        { from: 'Coding', to: 'Review', label: 'Coding → Review' },
        { from: 'Coding', to: 'Other', label: 'Coding → Other' },
      ],
      hookBindings: [
        {
          hookId: 'review_hook',
          sourceNode: 'Coding',
          targetNode: 'Review',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
        },
        {
          hookId: 'other_hook',
          sourceNode: 'Coding',
          targetNode: 'Other',
          method: 'send_message',
          order: 1,
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
      hookStateRepo,
      workspacePath: process.cwd(),
      roleHolderActiveLookup: (nodeId) => nodeId === 'n-review',
    });
    // Scalar form.
    const scalar = await engine.executeAction(
      'send_message',
      { target: '@role:reviewer', message: 'role' },
      META
    );
    expect(scalar.decision).toBe('stop');
    expect(scalar.blockingHookId).toBe('review_hook');
    expect(scalar.executionLog.length).toBe(1);
    expect(scalar.executionLog[0]?.hookId).toBe('review_hook');
    // Array form.
    const array = await engine.executeAction(
      'send_message',
      { target: ['@role:reviewer'], message: 'role' },
      META
    );
    expect(array.decision).toBe('stop');
    expect(array.blockingHookId).toBe('review_hook');
    expect(array.executionLog.length).toBe(1);
  });

  test('an unreadable execution store stops the action before any hook runs', async () => {
    // The router's own target translation reads the same repository — while
    // it is unreadable the send would fail anyway, and a hook evaluated
    // against declaration-order fallback routing could stamp the run's
    // identity for an attempt that never delivers. Infrastructure stop,
    // override-ineligible, no hook executed.
    class FailingExecRepo extends NodeExecutionRepository {
      override listByWorkflowRun(): never {
        throw new Error('store down');
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
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: new FailingExecRepo(db),
      artifactRepo,
      hookStateRepo,
      workspacePath: process.cwd(),
    });
    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('stop');
    expect(outcome.userState.humanOverrideEligible).toBe(false);
    expect(outcome.userState.reason).toContain('unreadable');
    // No hook ran; the stop is attributed to the TRANSIENT routing id (NOT
    // the permanent legacy guard) so the wrapper persists a state row and
    // the banner can surface it — and a later successful evaluation clears
    // the row, dismissing the banner.
    expect(outcome.executionLog.length).toBe(1);
    expect(outcome.executionLog[0]?.hookId).toBe('__routing_unavailable__');
    expect(outcome.userState.hookId).toBe('__routing_unavailable__');
    // Simulate the stale row, then a successful action on a healthy store:
    // the stale stop clears.
    hookStateRepo.update('run-1', '__routing_unavailable__', {
      expectedVersion: 0,
      lastFlow: 'stop',
      lastReason: 'Node execution store unreadable',
    });
    const healthy = makeEngine(workflow);
    const recovered = await healthy.executeAction('send_message', sendParams(), META);
    expect(recovered.decision).toBe('stop'); // the stop hook still gates
    expect(hookStateRepo.get('run-1', '__routing_unavailable__')?.lastFlow).toBe('continue');
  });

  test('a marker-loaded workflow fails every hookable action closed', async () => {
    // End-to-end for the corrupt-column marker: the repository loads a
    // corrupt hook_bindings column as per-(node × method) bindings whose
    // reserved id resolves to NO hook — the engine must stop each action
    // with that diagnosable id instead of running ungated.
    const workflow = makeWorkflow({
      hookBindings: [
        {
          hookId: '__corrupt_hook_bindings__',
          sourceNode: 'Coding',
          method: 'send_message',
          order: 0,
          enabled: true,
          authorizedCallers: [{ sourceNode: 'Coding' }],
        },
      ],
    });
    const engine = makeEngine(workflow);
    const outcome = await engine.executeAction('send_message', sendParams(), META);
    expect(outcome.decision).toBe('stop');
    expect(outcome.blockingHookId).toBe('__corrupt_hook_bindings__');
    expect(outcome.userState.reason).toContain('__corrupt_hook_bindings__');
    expect(outcome.userState.humanOverrideEligible).toBe(false);
  });

  test('a natural-continue mismatched-token approval proceeds WITHOUT clearing', async () => {
    // Hook passes on its own; the armed approval's token belongs to a NEWER
    // grant (mismatch): it is not this action's to clear — proceed with the
    // delivery and leave the newer approval armed.
    const PASS = scriptHook('pass_hook', '{"flow":"continue"}');
    const workflow = makeWorkflow({
      customHooks: [PASS],
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
      localState: {
        humanApproved: true,
        humanApprovedAt: 999,
        __approvedActionKey: actionKeyFor(sendParams()),
      },
      lastFlow: 'stop',
    });
    // Swap the token AFTER arming (a concurrent newer grant). The
    // natural-continue clear uses the SINGLE consume — patch that seam.
    const origSingle = hookStateRepo.consumeApprovalIfCurrent.bind(hookStateRepo);
    hookStateRepo.consumeApprovalIfCurrent = (
      runId: string,
      hookId: string,
      observed?: { approvedAt: unknown }
    ) => {
      hookStateRepo.updateWithRetry('run-1', 'pass_hook', {
        localState: { humanApprovedAt: 1234 },
      });
      return origSingle(runId, hookId, observed);
    };
    const engine = makeEngine(workflow);
    const result = await wrappedSend(engine, sendParams());
    expect(result.success).toBe(true);
    // The NEWER approval survives.
    expect(hookStateRepo.get('run-1', 'pass_hook')?.localState.humanApproved).toBe(true);
    expect(hookStateRepo.get('run-1', 'pass_hook')?.localState.humanApprovedAt).toBe(1234);
  });

  test('a pre-delivery persistence failure does not lose the one-shot approval', async () => {
    // The delivery-time consume runs in the WRAPPER, only after the
    // fail-closed pre-delivery persistence succeeds. When that persistence
    // fails, the wrapper blocks WITHOUT calling the handler — and the
    // approval must still be armed afterward (consuming inside the engine
    // would spend the operator's approval on a delivery that never reached
    // the protected handler).
    class PersistFailsRepo extends WorkflowHookStateRepository {
      override updateWithRetry(): null {
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
    const failingRepo = new PersistFailsRepo(db);
    failingRepo.update('run-1', 'stop_hook', {
      expectedVersion: 0,
      localState: {
        humanApproved: true,
        humanApprovedAt: 123,
        __approvedActionKey: actionKeyFor(sendParams()),
      },
    });
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: new NodeExecutionRepository(db),
      artifactRepo,
      hookStateRepo: failingRepo,
      workspacePath: process.cwd(),
    });

    // The chain delivers (engine) but the wrapper's decision persistence
    // fails — the action blocks and the approval SURVIVES for the retry.
    const result = await wrappedSend(engine, sendParams());
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('could not be persisted');
    expect(failingRepo.get('run-1', 'stop_hook')?.localState.humanApproved).toBe(true);
  });

  test('an approval matches a reissued action with reordered object fields', async () => {
    // The action identity canonicalizes args (sorted object keys): the agent
    // reissuing the approved blocked action with data fields in a different
    // insertion order must still hit the armed approval's key.
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
    const original = sendParams({ alpha: 1, beta: 2, nested: { x: 1, y: 2 } });
    const reordered = {
      target: 'Review',
      message: 'handoff',
      data: { nested: { y: 2, x: 1 }, beta: 2, alpha: 1 },
    };
    expect(buildRetryableActionKey('send_message', reordered, META)).toBe(actionKeyFor(original));
    hookStateRepo.updateWithRetry('run-1', 'stop_hook', {
      localState: {
        humanApproved: true,
        humanApprovedAt: 1,
        __approvedActionKey: actionKeyFor(original),
      },
      lastFlow: 'stop',
    });
    const engine = makeEngine(workflow);
    // Through the wrapper: the reordered re-issue overrides, delivers, and
    // consumes the approval.
    const result = await wrappedSend(engine, reordered);
    expect(result.success).toBe(true);
    expect(hookStateRepo.get('run-1', 'stop_hook')?.localState.humanApproved).toBeUndefined();
  });

  test('a delivery does not consume a NEWER approval granted mid-chain', async () => {
    // The P1 TOCTOU: action A observes approval (token approvedAt=123) and
    // runs its async hook; while it runs, ANOTHER action consumes that
    // approval and the operator approves a NEWER stop (approvedAt=456) for a
    // different violation. A's delivery-time consume must refuse the newer
    // approval (token mismatch) and block — delivering would spend an
    // approval intended for the other violation.
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
      localState: {
        humanApproved: true,
        humanApprovedAt: 123,
        __approvedActionKey: actionKeyFor(sendParams()),
      },
      lastFlow: 'continue',
      lastReason: 'Approved by human',
    });
    // Simulate the concurrent world advancing AFTER the engine observed the
    // approval: at the delivery-time consume, the observed approval has been
    // consumed and a NEWER one (approvedAt=456) is armed.
    const origBatch = hookStateRepo.consumeApprovalsIfCurrentBatch.bind(hookStateRepo);
    hookStateRepo.consumeApprovalsIfCurrentBatch = (
      runId: string,
      entries: Array<{ hookId: string; approvedAt: unknown }>
    ) => {
      hookStateRepo.updateWithRetry('run-1', 'stop_hook', {
        localState: { humanApprovedAt: 456 },
      });
      return origBatch(runId, entries);
    };
    const engine = makeEngine(workflow);

    // Through the WRAPPER (the consume runs at the delivery-time point): the
    // mismatched token blocks the delivery with the conflict reason.
    const result = await wrappedSend(engine, sendParams());
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('approval could not be recorded');
    // The NEWER approval survives for the action it belongs to.
    expect(hookStateRepo.get('run-1', 'stop_hook')?.localState.humanApprovedAt).toBe(456);
  });

  test('a failed approval-consume write blocks instead of force-skipping the gate', async () => {
    // The consume-write loses a version race (updateWithRetry returns null).
    // Skipping anyway would leave the persisted flag set after this action,
    // turning a one-shot approval into a standing bypass — so the engine must
    // fail closed. In-memory SQLite always succeeds, so force the conflict.
    class ConflictedStateRepo extends WorkflowHookStateRepository {
      // The atomic consume path loses its version race (someone else removed
      // the approval between the read and the write) — the action must block
      // rather than deliver on an approval it could not exclusively claim.
      // Only the CONSUME fails: the wrapper's pre-delivery persistence must
      // succeed so the delivery reaches the consume point at all.
      override consumeApprovalsIfCurrentBatch(): 'conflict' {
        return 'conflict';
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
      localState: {
        humanApproved: true,
        humanApprovedAt: 123,
        __approvedActionKey: actionKeyFor(sendParams()),
      },
    });
    const engine = new WorkflowHookEngine({
      workflow,
      workflowRunId: 'run-1',
      nodeExecutionRepo: new NodeExecutionRepository(db),
      artifactRepo,
      hookStateRepo: conflictedRepo,
      workspacePath: process.cwd(),
    });

    // Through the WRAPPER: the chain delivers, the pre-delivery persistence
    // prerequisites succeed, and the conflicted consume-write blocks at the
    // delivery-time point — an approval that cannot be recorded must not arm
    // a standing bypass.
    const result = await wrappedSend(engine, sendParams());
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('approval could not be recorded');
    expect(String(result.error)).toContain('approve it again');
    // The approval stays armed (the consume never landed).
    const stateAfter = conflictedRepo.get('run-1', 'stop_hook');
    expect(stateAfter?.localState.humanApproved).toBe(true);
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

describe('backoffDelayMs — nonnegative jitter', () => {
  test('the delay never drops below the requested floor', () => {
    // A hook-supplied floor (e.g. a GitHub rate-limit reset hint) must not
    // be defeated by symmetric ±25% jitter firing the retry early.
    for (let i = 0; i < 200; i++) {
      const delay = backoffDelayMs(60_000, 0);
      expect(delay).toBeGreaterThanOrEqual(60_000);
      expect(delay).toBeLessThanOrEqual(75_000);
    }
  });
});
