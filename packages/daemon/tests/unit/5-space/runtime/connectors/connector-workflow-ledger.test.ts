import { expect, test } from 'bun:test';
import type { WorkflowHook } from '@hyperneo/shared';
import {
  HookExecutor,
  type HookExecutorContext,
} from '../../../../../src/lib/hooks/hook-executor.ts';
import { createPrMergedValidator } from '../../../../../src/lib/github/connectors/presets.ts';
import { registerBuiltInValidator } from '../../../../../src/lib/hooks/built-in-validator-registry.ts';
import { createGithubConnector } from '../../../../../src/lib/github/connectors/github-connector.ts';
import { createCodingConnectorPrReader } from '../../../../../src/lib/neo/packs/coding/connector-pr-reader.ts';
import { createCodingPackTables } from '../../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';
import type { SpawnFn } from '../../../../../src/lib/runtime-spawn/index.ts';

const url = 'https://github.com/synthetic/wire/pull/7';
const hook: WorkflowHook = {
  id: 'merged',
  enabled: true,
  sourceNode: 'worker',
  method: 'send_message',
  validator: { kind: 'built_in', id: 'pr_merged' },
};
const context: HookExecutorContext = {
  workspacePath: '/tmp',
  runId: 'run',
  hookId: 'merged',
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
function fixture(state = 'MERGED') {
  const db = new Database(':memory:');
  createCodingPackTables(db);
  let calls = 0,
    fail = false;
  const read = createCodingConnectorPrReader(
    () => db,
    () => {
      calls++;
      return response(
        { url, state, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
        fail ? 1 : 0
      );
    }
  );
  const config = { workspacePath: '/tmp', readGithubPr: read };
  registerBuiltInValidator(
    'pr_merged',
    createPrMergedValidator(() => response({}, 1))
  );
  return {
    db,
    config,
    read,
    calls: () => calls,
    fail: () => {
      fail = true;
    },
  };
}

test('workflow hooks share a ledger acquisition and a failed refresh never falls back', async () => {
  const f = fixture();
  try {
    const executor = new HookExecutor(f.config);
    const results = await Promise.all([
      executor.execute(hook, context),
      executor.execute(hook, context),
    ]);
    expect(results.map((r) => r.result.type)).toEqual(['allow', 'allow']);
    expect(f.calls()).toBe(1);
    expect(await new HookExecutor(f.config).execute(hook, context)).toEqual({
      result: { type: 'allow' },
    });
    expect(f.calls()).toBe(2);
    const before = f.db.prepare('SELECT value_json,observed_at FROM pack_coding_poll_facts').get();
    f.fail();
    expect((await executor.execute(hook, context)).result.type).toBe('block');
    expect(f.db.prepare('SELECT value_json,observed_at FROM pack_coding_poll_facts').get()).toEqual(
      before
    );
  } finally {
    f.db.close();
  }
});

test('different daemon hook contexts retain separate ledger observations', async () => {
  const a = fixture(),
    b = fixture('OPEN');
  try {
    const results = await Promise.all([
      new HookExecutor(a.config).execute(hook, context),
      new HookExecutor(b.config).execute(hook, context),
    ]);
    expect(results.map((r) => r.result.type)).toEqual(['allow', 'retryable_block']);
    expect([a.calls(), b.calls()]).toEqual([1, 1]);
  } finally {
    a.db.close();
    b.db.close();
  }
});

test('readiness uses ledger PR basics while preserving its existing thread lookup', async () => {
  const f = fixture();
  const calls: string[][] = [];
  const connector = createGithubConnector((args) => {
    calls.push(args as string[]);
    return response({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
    });
  });
  try {
    const ctx = { workspacePath: '/tmp', params: {}, hookLocalState: {}, readPr: f.read };
    const result = await connector.ops.getPrReadiness({ prUrl: url }, ctx);
    expect(result).toEqual({
      ok: true,
      data: {
        url,
        state: 'MERGED',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        unresolvedThreadUrls: [],
      },
    });
    expect(f.calls()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('graphql');
  } finally {
    f.db.close();
  }
});
