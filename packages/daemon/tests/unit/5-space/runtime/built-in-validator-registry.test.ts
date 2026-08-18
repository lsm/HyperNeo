import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { BuiltInValidatorFn } from '../../../../src/lib/space/runtime/hook-executor';
import type { HookExecutorContext } from '../../../../src/lib/space/runtime/hook-executor';
import {
  clearBuiltInValidatorRegistry,
  getBuiltInValidator,
  getRegisteredBuiltInValidatorIds,
  isRegisteredBuiltInValidator,
  registerBuiltInValidator,
} from '../../../../src/lib/space/runtime/built-in-validator-registry';
import '../../../../src/lib/space/runtime/built-in-validators';
import { registerProductionBuiltInValidators } from '../../../../src/lib/space/runtime/built-in-validators';
import { createPrMergedValidator } from '../../../../src/lib/space/runtime/connectors/presets';

const PR_URL = 'https://github.com/acme/corp/pull/42';

function streamFromString(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function mockSpawn(stdout: string, exitCode = 0): typeof Bun.spawn {
  return (() =>
    ({
      stdout: streamFromString(stdout),
      stderr: streamFromString(''),
      exited: Promise.resolve(exitCode),
      pid: 12345,
      kill() {},
    }) as unknown) as ReturnType<typeof Bun.spawn>;
}

function ctx(): HookExecutorContext {
  return {
    workspacePath: '/tmp',
    runId: 'run-1',
    hookId: 'hook-1',
    methodName: 'mark_complete',
    params: { data: { pr_url: PR_URL } },
    nodeId: 'node-1',
    nodeName: 'Review',
    sessionId: 'sess-1',
    taskId: 'task-1',
    hookLocalState: {},
    currentArtifacts: [],
    permittedExternalLookups: ['github'],
  };
}

let registrySnapshot = new Map<string, BuiltInValidatorFn>();

beforeAll(() => {
  registrySnapshot = new Map(
    getRegisteredBuiltInValidatorIds().map((id) => [id, getBuiltInValidator(id)!])
  );
});

afterEach(() => {
  clearBuiltInValidatorRegistry();
  for (const [id, fn] of registrySnapshot) registerBuiltInValidator(id, fn);
});

describe('built-in validator registry', () => {
  test('register / get / isRegistered / clear contract', () => {
    clearBuiltInValidatorRegistry();
    expect(isRegisteredBuiltInValidator('custom')).toBe(false);
    expect(getBuiltInValidator('custom')).toBeUndefined();

    const fn = async () => ({ type: 'allow' as const });
    registerBuiltInValidator('custom', fn);
    expect(isRegisteredBuiltInValidator('custom')).toBe(true);
    expect(getBuiltInValidator('custom')).toBe(fn);
    expect(getRegisteredBuiltInValidatorIds()).toContain('custom');

    clearBuiltInValidatorRegistry();
    expect(isRegisteredBuiltInValidator('custom')).toBe(false);
    expect(getRegisteredBuiltInValidatorIds()).toEqual([]);
  });

  test('production seeding registers pr_ready + pr_merged (the named presets)', () => {
    clearBuiltInValidatorRegistry();
    registerProductionBuiltInValidators();
    expect(getRegisteredBuiltInValidatorIds()).toEqual(
      expect.arrayContaining(['pr_ready', 'pr_merged'])
    );
    expect(getBuiltInValidator('pr_ready')).toBeDefined();
    expect(getBuiltInValidator('pr_merged')).toBeDefined();
  });
});

describe('pr_merged dispatches through the registry (no engine special-casing)', () => {
  test('MERGED → allow via the registered preset', async () => {
    registerBuiltInValidator(
      'pr_merged',
      createPrMergedValidator(mockSpawn(JSON.stringify({ url: PR_URL, state: 'MERGED' })))
    );
    const fn = getBuiltInValidator('pr_merged');
    expect(fn).toBeDefined();
    const result = await fn!(ctx());
    expect(result.type).toBe('allow');
  });

  test('CLOSED → terminal block via the registered preset', async () => {
    registerBuiltInValidator(
      'pr_merged',
      createPrMergedValidator(mockSpawn(JSON.stringify({ url: PR_URL, state: 'CLOSED' })))
    );
    const result = await getBuiltInValidator('pr_merged')!(ctx());
    expect(result.type).toBe('block');
  });

  test('OPEN → retryable_block (merge in flight) via the registered preset', async () => {
    registerBuiltInValidator(
      'pr_merged',
      createPrMergedValidator(mockSpawn(JSON.stringify({ url: PR_URL, state: 'OPEN' })))
    );
    const result = await getBuiltInValidator('pr_merged')!(ctx());
    expect(result.type).toBe('retryable_block');
  });
});
