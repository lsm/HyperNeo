import { expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { WorkflowHook } from '@hyperneo/shared';
import {
  HookExecutor,
  type HookExecutorContext,
} from '../../../../../src/lib/hooks/hook-executor.ts';
import { registerBuiltInValidator } from '../../../../../src/lib/hooks/built-in-validator-registry.ts';
import { createPrReadyValidator } from '../../../../../src/lib/workflows/built-in-validators/pr-ready-validator.ts';
import { createExternalStateValidator } from '../../../../../src/lib/github/connectors/external-state-validator.ts';
import { createGithubConnector } from '../../../../../src/lib/github/connectors/github-connector.ts';
import { registerConnector } from '../../../../../src/lib/github/connectors/connector.ts';
import { createCodingConnectorPrReader } from '../../../../../src/lib/neo/packs/coding/connector-pr-reader.ts';
import { createCodingReviewThreadReader } from '../../../../../src/lib/neo/packs/coding/connector-review-thread-reader.ts';
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
  let basic = 0,
    threads = 0,
    direct = 0,
    failed = false,
    unresolved = false;
  const spawn: SpawnFn = (args) => {
    if (args[1] === 'pr') {
      basic++;
      return response({ url, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
    }
    threads++;
    return response(
      {
        data: {
          repository: {
            pullRequest: {
              url,
              headRefOid: 'a'.repeat(40),
              reviewThreads: {
                nodes: unresolved
                  ? [
                      {
                        id: 'thread',
                        isResolved: false,
                        comments: { nodes: [{ url: `${url}#discussion_1` }] },
                      },
                    ]
                  : [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
      failed ? 1 : 0
    );
  };
  const refuse: SpawnFn = () => {
    direct++;
    return response({}, 1);
  };
  registerBuiltInValidator('pr_ready', createPrReadyValidator(refuse));
  registerConnector(createGithubConnector(refuse));
  registerBuiltInValidator(
    'ledger-readiness',
    createExternalStateValidator({
      connector: 'github',
      op: 'getPrReadiness',
      params: () => ({ prUrl: url }),
      pass: { eq: ['state', 'OPEN'] },
      label: 'Readiness',
    })
  );
  const config = {
    workspacePath: '/tmp',
    readGithubPr: createCodingConnectorPrReader(() => db, spawn),
    readGithubReviewThreads: createCodingReviewThreadReader(() => db, spawn),
  };
  return {
    db,
    config,
    counters: () => ({ basic, threads, direct }),
    fail: () => {
      failed = true;
    },
    unresolved: () => {
      unresolved = true;
    },
  };
}

test('production pr_ready and connector readiness share both ledger acquisition families', async () => {
  const f = fixture();
  try {
    const connectorHook = {
      ...hook,
      validator: { kind: 'built_in' as const, id: 'ledger-readiness' },
    };
    const executor = new HookExecutor(f.config);
    const results = await Promise.all([
      executor.execute(hook, context),
      executor.execute(connectorHook, context),
    ]);
    expect(results.map((r) => r.result.type)).toEqual(['allow', 'allow']);
    expect(f.counters()).toEqual({ basic: 1, threads: 1, direct: 0 });
    f.unresolved();
    const blocked = await executor.execute(hook, context);
    expect(blocked.result).toMatchObject({
      type: 'block',
      reason: expect.stringContaining('#discussion_1'),
    });
    expect(f.counters().direct).toBe(0);
  } finally {
    f.db.close();
  }
});

test('failed thread refresh retains history and blocks both consumers without fallback', async () => {
  const f = fixture();
  try {
    const executor = new HookExecutor(f.config);
    expect((await executor.execute(hook, context)).result.type).toBe('allow');
    const rows = () =>
      f.db
        .prepare(
          "SELECT value_json,observed_at FROM pack_coding_poll_facts WHERE json_extract(subject,'$[2]') = 'application/vnd.hyperneo.pr-review-threads+json'"
        )
        .get();
    const before = rows();
    f.fail();
    const result = await executor.execute(hook, context);
    expect(result.result.type).toBe('block');
    expect(JSON.stringify(result)).toContain('unavailable');
    expect(rows()).toEqual(before);
    const ctx = {
      workspacePath: '/tmp',
      params: {},
      hookLocalState: {},
      readPr: f.config.readGithubPr,
      readReviewThreads: f.config.readGithubReviewThreads,
    };
    expect(
      (
        await createGithubConnector(() => {
          throw new Error('Direct fallback');
        }).ops.getPrReadiness({ prUrl: url }, ctx)
      ).ok
    ).toBe(false);
    expect(f.counters().direct).toBe(0);
  } finally {
    f.db.close();
  }
});

test('shared thread reads preserve the production readiness deadline', async () => {
  const f = fixture();
  vi.useFakeTimers();
  try {
    const config = { ...f.config, readGithubReviewThreads: () => new Promise<never>(() => {}) };
    const pending = new HookExecutor(config).execute(hook, context);
    await vi.advanceTimersByTimeAsync(30001);
    const result = await pending;
    expect(result.result.type).toBe('block');
    expect(JSON.stringify(result)).toMatch(/timed out/i);
    expect(f.counters().direct).toBe(0);
  } finally {
    vi.useRealTimers();
    f.db.close();
  }
});

test('thread rate limits preserve retry outcome and delay', async () => {
  const f = fixture();
  try {
    const config = {
      ...f.config,
      readGithubReviewThreads: async () => ({
        ok: false as const,
        error: 'API rate limit exceeded',
        retryable: true,
        retryAfterMs: 60000,
      }),
    };
    expect((await new HookExecutor(config).execute(hook, context)).result).toMatchObject({
      type: 'retryable_block',
      retryAfterMs: 60000,
    });
    expect(f.counters().direct).toBe(0);
  } finally {
    f.db.close();
  }
});
