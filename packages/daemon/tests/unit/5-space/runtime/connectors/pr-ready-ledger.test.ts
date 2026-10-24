import { expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { WorkflowHook } from '@hyperneo/shared';
import {
  HookExecutor,
  type HookExecutorContext,
} from '../../../../../src/lib/hooks/hook-executor.ts';
import { registerBuiltInValidator } from '../../../../../src/lib/hooks/built-in-validator-registry.ts';
import { createPrReadyValidator } from '../../../../../src/lib/workflows/built-in-validators/pr-ready-validator.ts';
import { createCodingConnectorPrReader } from '../../../../../src/lib/neo/packs/coding/connector-pr-reader.ts';
import { createCodingPackTables } from '../../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import type { SpawnFn } from '../../../../../src/lib/runtime-spawn/index.ts';

const url = 'https://github.com/synthetic/ready/pull/7';
const hook: WorkflowHook = {
  id: 'ready',
  enabled: true,
  sourceNode: 'worker',
  method: 'send_message',
  validator: { kind: 'built_in', id: 'pr_ready' },
};
const context: HookExecutorContext = {
  workspacePath: '/tmp',
  runId: 'run',
  hookId: 'ready',
  methodName: 'send_message',
  params: { data: { pr_url: url } },
  nodeId: 'worker',
  nodeName: 'worker',
  sessionId: 'worker',
  taskId: 'task',
  hookLocalState: {},
  currentArtifacts: [],
  permittedExternalLookups: ['github'],
};
function response(data: unknown, code = 0): ReturnType<SpawnFn> {
  return {
    stdout: new Response(JSON.stringify(data)).body!,
    stderr: new Response('Synthetic unavailable').body!,
    exited: Promise.resolve(code),
    pid: 12345,
    kill() {},
  } as ReturnType<SpawnFn>;
}
function fixture() {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  const view = { url, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  let basic = 0,
    threads = 0,
    direct = 0,
    fail = false;
  const read = createCodingConnectorPrReader(
    () => db,
    () => {
      basic++;
      return response(view, fail ? 1 : 0);
    }
  );
  registerBuiltInValidator(
    'pr_ready',
    createPrReadyValidator((args) => {
      if (args[1] !== 'api') {
        direct++;
        return response({}, 1);
      }
      threads++;
      return response({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        },
      });
    })
  );
  const config = { workspacePath: '/tmp', readGithubPr: read };
  return {
    db,
    view,
    config,
    counters: () => ({ basic, threads, direct }),
    fail: () => {
      fail = true;
    },
  };
}

test('production pr_ready shares basic facts and preserves later readiness decisions', async () => {
  const f = fixture();
  try {
    const execute = () => new HookExecutor(f.config).execute(hook, context);
    expect((await Promise.all([execute(), execute()])).map((r) => r.result.type)).toEqual([
      'allow',
      'allow',
    ]);
    expect(f.counters()).toEqual({ basic: 1, threads: 2, direct: 0 });
    f.view.mergeable = 'UNKNOWN';
    expect((await execute()).result.type).toBe('retryable_block');
    f.view.mergeable = 'MERGEABLE';
    f.view.state = 'CLOSED';
    expect((await execute()).result.type).toBe('block');
    f.view.state = 'OPEN';
    f.view.mergeStateStatus = 'DIRTY';
    expect((await execute()).result.type).toBe('block');
    expect(f.counters().threads).toBe(2);
  } finally {
    f.db.close();
  }
});

test('failed latest basic facts retain history and block without direct fallback', async () => {
  const f = fixture();
  try {
    const executor = new HookExecutor(f.config);
    expect((await executor.execute(hook, context)).result.type).toBe('allow');
    const before = f.db.prepare('SELECT value_json,observed_at FROM pack_coding_poll_facts').get();
    f.fail();
    const blocked = await executor.execute(hook, context);
    expect(blocked.result.type).toBe('block');
    expect(JSON.stringify(blocked)).toContain('unavailable');
    expect(f.db.prepare('SELECT value_json,observed_at FROM pack_coding_poll_facts').get()).toEqual(
      before
    );
    expect(f.counters()).toEqual({ basic: 2, threads: 1, direct: 0 });
  } finally {
    f.db.close();
  }
});

test('ledger rate limits retain the existing readiness retry and delay', async () => {
  const f = fixture();
  try {
    const config = {
      workspacePath: '/tmp',
      readGithubPr: async () => ({
        ok: false as const,
        error: 'API rate limit exceeded',
        retryable: true,
        retryAfterMs: 60000,
      }),
    };
    const result = (await new HookExecutor(config).execute(hook, context)).result;
    expect(result).toMatchObject({ type: 'retryable_block', retryAfterMs: 60000 });
    expect(f.counters()).toEqual({ basic: 0, threads: 0, direct: 0 });
  } finally {
    f.db.close();
  }
});

test('a shared ledger acquisition cannot extend the readiness deadline', async () => {
  const f = fixture();
  vi.useFakeTimers();
  try {
    const config = { workspacePath: '/tmp', readGithubPr: () => new Promise<never>(() => {}) };
    const pending = new HookExecutor(config).execute(hook, context);
    await vi.advanceTimersByTimeAsync(30001);
    const result = await pending;
    expect(result.result.type).toBe('block');
    expect(JSON.stringify(result)).toMatch(/timed out/i);
    expect(f.counters()).toEqual({ basic: 0, threads: 0, direct: 0 });
  } finally {
    vi.useRealTimers();
    f.db.close();
  }
});
