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
import { spawn as nodeSpawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { Database } from '../../../../src/storage/sqlite-compat';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository';
import { WorkflowHookStateRepository } from '../../../../src/storage/repositories/workflow-hook-state-repository';
import { WorkflowHookEngine } from '../../../../src/lib/space/runtime/workflow-hook-engine';
import type { HookActionMeta } from '../../../../src/lib/space/runtime/workflow-hook-engine';
import { createSpaceTables } from '../../helpers/space-test-db.ts';
import type { CustomHook, HookArtifact, SpaceWorkflow } from '@hyperneo/shared';

// Under Vitest/Node there is no global `Bun`, and the engine's script-hook
// runner calls `Bun.spawn` at call time (same situation as the dialog-handlers
// tests). Install a child_process-backed stand-in exposing the surface the
// engine touches (stdout/stderr streams, `exited` promise, `kill`); under
// `bun test` the real global is left untouched.
if (typeof (globalThis as Record<string, unknown>).Bun === 'undefined') {
  (globalThis as Record<string, unknown>).Bun = {
    spawn: (args: string[], opts: { cwd?: string; env?: Record<string, string> }): unknown => {
      const child = nodeSpawn(args[0], args.slice(1), {
        cwd: opts?.cwd,
        env: opts?.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return {
        // The engine collects Bun-style WEB ReadableStreams; convert Node's.
        stdout: child.stdout ? Readable.toWeb(child.stdout) : null,
        stderr: child.stderr ? Readable.toWeb(child.stderr) : null,
        exited: new Promise<number>((resolve) => {
          child.on('exit', (code) => resolve(code ?? -1));
        }),
        kill: (signal?: string) => {
          try {
            child.kill(signal ?? 'SIGKILL');
          } catch {
            /* already exited */
          }
        },
      };
    },
  };
}

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

    // First attempt after approval: hook skipped, action delivers.
    const first = await engine.executeAction('send_message', sendParams(), META);
    expect(first.decision).toBe('deliver');
    expect(
      first.executionLog.some((e) => e.reason === 'Human override: hook skipped by approval')
    ).toBe(true);
    // The one-shot flag was consumed.
    expect(hookStateRepo.get('run-1', 'stop_hook')?.localState.humanApproved).toBeUndefined();

    // Second attempt: the hook gates again.
    const second = await engine.executeAction('send_message', sendParams(), META);
    expect(second.decision).toBe('stop');
    expect(second.blockingHookId).toBe('stop_hook');
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
    const artifacts: HookArtifact[] = [];
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

    // Re-writing the same key replaces in place (upsert semantics) instead of
    // appending a duplicate.
    first.ctx.writeArtifact({
      artifactType: 'link',
      artifactKey: '__pr_validated__',
      data: { link: 'https://github.com/o/r/pull/2', kind: 'pr' },
    });
    const after = artifacts.filter((a) => a.artifactKey === '__pr_validated__');
    expect(after).toHaveLength(1);
    expect(after[0]?.data.link).toBe('https://github.com/o/r/pull/2');
  });
});
