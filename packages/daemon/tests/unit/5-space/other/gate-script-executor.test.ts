/**
 * Gate Script Executor Unit Tests
 *
 * Covers:
 *   - buildRestrictedEnv: credential stripping, allowlist, injection, user env merging
 *   - deepMergeWithDepthLimit: deep merge, depth limit, prototype pollution rejection
 *   - parseJsonStdout: valid JSON, empty, invalid, non-object
 *   - executeGateScript: success, non-zero exit, timeout, maxBuffer, spawn errors
 *
 * NOTE: Integration tests that call executeGateScript() use real Bun.spawn() with
 * node/bash. The buildRestrictedEnv describe block manipulates process.env; its
 * afterEach restores PATH to the original value so subsequent integration tests can
 * find the interpreters.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { realpathSync } from 'node:fs';
import {
  buildRestrictedEnv,
  deepMergeWithDepthLimit,
  parseJsonStdout,
  executeGateScript,
} from '../../../../src/lib/space/runtime/gate-script-executor.ts';
import type { GateScriptContext } from '../../../../src/lib/space/runtime/gate-script-executor.ts';
import type { GateScript } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CTX: GateScriptContext = {
  workspacePath: '/tmp',
  gateId: 'gate-123',
  runId: 'run-456',
};

/** Probes whether python3 is available on this system. */
async function isPython3Available(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['python3', '-c', 'print("hello")'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await proc.exited;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// buildRestrictedEnv
// ---------------------------------------------------------------------------

describe('buildRestrictedEnv', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env['HOME'] = '/home/user';
    process.env['USER'] = 'testuser';
    process.env['SHELL'] = '/bin/bash';
    process.env['LANG'] = 'en_US.UTF-8';
    process.env['TERM'] = 'xterm-256color';
    process.env['TMPDIR'] = '/tmp';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-secret';
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'oauth-secret';
    process.env['GLM_API_KEY'] = 'glm-secret';
    process.env['ZHIPU_API_KEY'] = 'zhipu-secret';
    process.env['COPILOT_GITHUB_TOKEN'] = 'copilot-secret';
    process.env['NEOKAI_SECRET_X'] = 'neokai-secret';
    process.env['NEOKAI_PORT'] = '8080';
    process.env['NEOKAI_USE_DEV_PROXY'] = '1';
    process.env['MY_SECRET_KEY'] = 'my-secret';
    process.env['DB_PASSWORD'] = 'db-secret';
    process.env['AWS_CREDENTIAL'] = 'aws-secret';
    process.env['SOME_API_KEY'] = 'api-secret';
    process.env['GH_TOKEN'] = 'ghp-test-token';
    process.env['GITHUB_TOKEN'] = 'gho-test-token';
    process.env['GH_HOST'] = 'github.com';
    process.env['MY_OTHER_VAR'] = 'safe-value';
    process.env['NODE_ENV'] = 'test';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key] as string;
      }
    }
  });

  test('strips ANTHROPIC_ prefixed env vars', () => {
    expect(buildRestrictedEnv(CTX)['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  test('strips CLAUDE_ prefixed env vars', () => {
    expect(buildRestrictedEnv(CTX)['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
  });

  test('strips GLM_ prefixed env vars', () => {
    expect(buildRestrictedEnv(CTX)['GLM_API_KEY']).toBeUndefined();
  });

  test('strips ZHIPU_ prefixed env vars', () => {
    expect(buildRestrictedEnv(CTX)['ZHIPU_API_KEY']).toBeUndefined();
  });

  test('strips COPILOT_ prefixed env vars', () => {
    expect(buildRestrictedEnv(CTX)['COPILOT_GITHUB_TOKEN']).toBeUndefined();
  });

  test('strips NEOKAI_SECRET_ prefixed env vars', () => {
    expect(buildRestrictedEnv(CTX)['NEOKAI_SECRET_X']).toBeUndefined();
  });

  test('strips broader NEOKAI_ prefixed env vars (internal ops)', () => {
    expect(buildRestrictedEnv(CTX)['NEOKAI_PORT']).toBeUndefined();
    expect(buildRestrictedEnv(CTX)['NEOKAI_USE_DEV_PROXY']).toBeUndefined();
  });

  test('strips env vars matching SECRET key pattern', () => {
    expect(buildRestrictedEnv(CTX)['MY_SECRET_KEY']).toBeUndefined();
  });

  test('strips env vars matching PASSWORD key pattern', () => {
    expect(buildRestrictedEnv(CTX)['DB_PASSWORD']).toBeUndefined();
  });

  test('strips env vars matching CREDENTIAL key pattern', () => {
    expect(buildRestrictedEnv(CTX)['AWS_CREDENTIAL']).toBeUndefined();
  });

  test('strips env vars matching API_KEY key pattern', () => {
    expect(buildRestrictedEnv(CTX)['SOME_API_KEY']).toBeUndefined();
  });

  test('allows PATH in env', () => {
    expect(buildRestrictedEnv(CTX)['PATH']).toBeDefined();
  });

  test('allows HOME in env', () => {
    expect(buildRestrictedEnv(CTX)['HOME']).toBe('/home/user');
  });

  test('allows USER in env', () => {
    expect(buildRestrictedEnv(CTX)['USER']).toBe('testuser');
  });

  test('allows SHELL in env', () => {
    expect(buildRestrictedEnv(CTX)['SHELL']).toBe('/bin/bash');
  });

  test('allows LANG in env', () => {
    expect(buildRestrictedEnv(CTX)['LANG']).toBe('en_US.UTF-8');
  });

  test('allows TERM in env', () => {
    expect(buildRestrictedEnv(CTX)['TERM']).toBe('xterm-256color');
  });

  test('allows TMPDIR in env', () => {
    expect(buildRestrictedEnv(CTX)['TMPDIR']).toBe('/tmp');
  });

  test('allows GH_TOKEN in env (GitHub CLI auth)', () => {
    expect(buildRestrictedEnv(CTX)['GH_TOKEN']).toBe('ghp-test-token');
  });

  test('allows GITHUB_TOKEN in env (GitHub Actions auth)', () => {
    expect(buildRestrictedEnv(CTX)['GITHUB_TOKEN']).toBe('gho-test-token');
  });

  test('allows GH_HOST in env (GitHub Enterprise)', () => {
    expect(buildRestrictedEnv(CTX)['GH_HOST']).toBe('github.com');
  });

  test('allows non-restricted env vars', () => {
    const env = buildRestrictedEnv(CTX);
    expect(env['MY_OTHER_VAR']).toBe('safe-value');
    expect(env['NODE_ENV']).toBe('test');
  });

  test('injects NEOKAI_GATE_ID after filtering', () => {
    // NEOKAI_ prefix vars are stripped, but these three are re-injected
    expect(buildRestrictedEnv(CTX)['NEOKAI_GATE_ID']).toBe('gate-123');
  });

  test('injects NEOKAI_WORKFLOW_RUN_ID after filtering', () => {
    expect(buildRestrictedEnv(CTX)['NEOKAI_WORKFLOW_RUN_ID']).toBe('run-456');
  });

  test('injects NEOKAI_WORKSPACE_PATH after filtering', () => {
    expect(buildRestrictedEnv(CTX)['NEOKAI_WORKSPACE_PATH']).toBe('/tmp');
  });

  test('injects NEOKAI_GATE_DATA_JSON from context gateData', () => {
    const env = buildRestrictedEnv({
      ...CTX,
      gateData: { pr_url: 'https://github.com/example/repo/pull/42', approved: true },
    });
    expect(env['NEOKAI_GATE_DATA_JSON']).toBe(
      '{"pr_url":"https://github.com/example/repo/pull/42","approved":true}'
    );
  });

  test('injects default empty NEOKAI_GATE_DATA_JSON when gateData is absent', () => {
    expect(buildRestrictedEnv(CTX)['NEOKAI_GATE_DATA_JSON']).toBe('{}');
  });

  test('does not inject field-specific aliases (template data stays in JSON payload)', () => {
    const env = buildRestrictedEnv({
      ...CTX,
      gateData: { pr_url: 'https://github.com/example/repo/pull/42' },
    });
    expect(env['NEOKAI_GATE_PR_URL']).toBeUndefined();
  });

  test('merges user-provided env vars (safe ones)', () => {
    expect(buildRestrictedEnv(CTX, { MY_CUSTOM_VAR: 'custom-value' })['MY_CUSTOM_VAR']).toBe(
      'custom-value'
    );
  });

  test('user env cannot override NEOKAI_GATE_ID', () => {
    expect(buildRestrictedEnv(CTX, { NEOKAI_GATE_ID: 'hacked' })['NEOKAI_GATE_ID']).toBe(
      'gate-123'
    );
  });

  test('user env cannot override NEOKAI_WORKFLOW_RUN_ID', () => {
    expect(
      buildRestrictedEnv(CTX, { NEOKAI_WORKFLOW_RUN_ID: 'hacked' })['NEOKAI_WORKFLOW_RUN_ID']
    ).toBe('run-456');
  });

  test('user env cannot override NEOKAI_WORKSPACE_PATH', () => {
    expect(
      buildRestrictedEnv(CTX, { NEOKAI_WORKSPACE_PATH: '/hacked' })['NEOKAI_WORKSPACE_PATH']
    ).toBe('/tmp');
  });

  test('user env cannot override NEOKAI_GATE_DATA_JSON', () => {
    expect(
      buildRestrictedEnv(
        { ...CTX, gateData: { approved: true } },
        { NEOKAI_GATE_DATA_JSON: '{"approved":false}' }
      )['NEOKAI_GATE_DATA_JSON']
    ).toBe('{"approved":true}');
  });

  test('user env cannot introduce field-specific NEOKAI aliases', () => {
    expect(
      buildRestrictedEnv(
        { ...CTX, gateData: { pr_url: 'https://github.com/example/repo/pull/42' } },
        { NEOKAI_GATE_PR_URL: 'https://attacker.invalid/pr/1' }
      )['NEOKAI_GATE_PR_URL']
    ).toBeUndefined();
  });

  test('user env with restricted prefixes is stripped', () => {
    expect(
      buildRestrictedEnv(CTX, { ANTHROPIC_CUSTOM: 'leak' })['ANTHROPIC_CUSTOM']
    ).toBeUndefined();
  });

  test('user env with NEOKAI_ prefix is stripped', () => {
    expect(buildRestrictedEnv(CTX, { NEOKAI_CUSTOM: 'leak' })['NEOKAI_CUSTOM']).toBeUndefined();
  });

  test('user env with SECRET pattern is stripped', () => {
    expect(buildRestrictedEnv(CTX, { LEAK_SECRET: 'leak' })['LEAK_SECRET']).toBeUndefined();
  });

  test('user env with TOKEN pattern is stripped', () => {
    expect(buildRestrictedEnv(CTX, { LEAK_TOKEN: 'leak' })['LEAK_TOKEN']).toBeUndefined();
  });

  test('user env with PASSWORD pattern is stripped', () => {
    expect(buildRestrictedEnv(CTX, { LEAK_PASSWORD: 'leak' })['LEAK_PASSWORD']).toBeUndefined();
  });

  test('user env with CREDENTIAL pattern is stripped', () => {
    expect(buildRestrictedEnv(CTX, { LEAK_CREDENTIAL: 'leak' })['LEAK_CREDENTIAL']).toBeUndefined();
  });

  test('user env with API_KEY pattern is stripped', () => {
    expect(buildRestrictedEnv(CTX, { LEAK_API_KEY: 'leak' })['LEAK_API_KEY']).toBeUndefined();
  });

  test('works without user env parameter', () => {
    expect(buildRestrictedEnv(CTX)['NEOKAI_GATE_ID']).toBe('gate-123');
  });

  test('injects NEOKAI_WORKFLOW_START_ISO when context provides it', () => {
    const env = buildRestrictedEnv({
      ...CTX,
      workflowStartIso: '2026-04-19T10:00:00.000Z',
    });
    expect(env['NEOKAI_WORKFLOW_START_ISO']).toBe('2026-04-19T10:00:00.000Z');
  });

  test('does not inject NEOKAI_WORKFLOW_START_ISO when context omits it', () => {
    // When workflowStartIso isn't resolvable (e.g. old run, test harness),
    // we leave the var unset rather than defaulting to something misleading.
    expect(buildRestrictedEnv(CTX)['NEOKAI_WORKFLOW_START_ISO']).toBeUndefined();
  });

  test('user env cannot override NEOKAI_WORKFLOW_START_ISO', () => {
    const env = buildRestrictedEnv(
      { ...CTX, workflowStartIso: '2026-04-19T10:00:00.000Z' },
      { NEOKAI_WORKFLOW_START_ISO: '1970-01-01T00:00:00.000Z' }
    );
    expect(env['NEOKAI_WORKFLOW_START_ISO']).toBe('2026-04-19T10:00:00.000Z');
  });

  test('user env cannot spoof NEOKAI_WORKFLOW_START_ISO when context omits it', () => {
    // Even with no context-provided value, agents must not be able to set the
    // var themselves — that would let them backdate reviews and bypass the gate.
    const env = buildRestrictedEnv(CTX, {
      NEOKAI_WORKFLOW_START_ISO: '2020-01-01T00:00:00.000Z',
    });
    expect(env['NEOKAI_WORKFLOW_START_ISO']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deepMergeWithDepthLimit
// ---------------------------------------------------------------------------

describe('deepMergeWithDepthLimit', () => {
  test('merges flat objects', () => {
    expect(deepMergeWithDepthLimit({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  test('overwrites existing keys', () => {
    expect(deepMergeWithDepthLimit({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  test('deep merges nested objects', () => {
    expect(deepMergeWithDepthLimit({ n: { a: 1, b: 2 } }, { n: { b: 3, c: 4 } })).toEqual({
      n: { a: 1, b: 3, c: 4 },
    });
  });

  test('respects max depth limit — stops recursion at depth boundary', () => {
    // Both target and source have overlapping nested structures so the
    // recursive merge branch is taken. At maxDepth=2, the merge should
    // stop recursing at depth 2, preserving the target value at that level.
    const target: Record<string, unknown> = {
      a: { b: { c: { d: 'original' } } },
    };
    const source = {
      a: { b: { c: { d: 'replaced' }, e: 'added' } },
    };

    // maxDepth=2: depth 0 merges 'a' (recurse), depth 1 merges 'b' (recurse),
    // depth 2 >= maxDepth → returns target.b unchanged (no 'e' added, 'd' stays original)
    const result = deepMergeWithDepthLimit(target, source, 2);

    // a.b preserved from target — depth limit prevented recursive merge
    const b = (result['a'] as Record<string, unknown>)['b'] as Record<string, unknown>;
    expect((b['c'] as Record<string, unknown>)['d']).toBe('original');
    // 'e' was never merged in because recursion stopped at depth 2
    expect(b['e']).toBeUndefined();
  });

  test('respects max depth limit — deeper nesting preserved at boundary', () => {
    const target: Record<string, unknown> = {
      l1: { l2: { l3: { l4: 'deep' } } },
    };
    const source = {
      l1: { l2: { l3: { l4: 'replaced' } } },
    };

    // maxDepth=3: depth 0 merges l1, depth 1 merges l2, depth 2 merges l3 (recurse),
    // depth 3 >= maxDepth → returns target.l3 unchanged (l4 stays 'deep')
    const result = deepMergeWithDepthLimit(target, source, 3);
    const l3 = ((result['l1'] as Record<string, unknown>)['l2'] as Record<string, unknown>)[
      'l3'
    ] as Record<string, unknown>;
    // l4 preserved from target — depth limit prevented recursive merge
    expect(l3['l4']).toBe('deep');
  });

  test('default depth limit (5) allows merging up to 5 levels deep', () => {
    const target: Record<string, unknown> = {
      a: { b: { c: { d: { e: 'original' } } } },
    };
    const source = {
      a: { b: { c: { d: { e: 'replaced' } } } },
    };

    // 5 levels: a(depth 0) → b(depth 1) → c(depth 2) → d(depth 3) → e(depth 4)
    // All within maxDepth=5, so the leaf value is replaced
    const result = deepMergeWithDepthLimit(target, source);
    const e = (
      (
        ((result['a'] as Record<string, unknown>)['b'] as Record<string, unknown>)['c'] as Record<
          string,
          unknown
        >
      )['d'] as Record<string, unknown>
    )['e'] as string;
    expect(e).toBe('replaced');
  });

  test('default depth limit (5) stops at 6th level', () => {
    const target: Record<string, unknown> = {
      a: { b: { c: { d: { e: { f: 'original' } } } } },
    };
    const source = {
      a: { b: { c: { d: { e: { f: 'replaced' } } } } },
    };

    // 6 levels: a(0) → b(1) → c(2) → d(3) → e(4) → f(5, blocked by maxDepth)
    // f is at depth 5 which equals maxDepth → returns target.e unchanged
    const result = deepMergeWithDepthLimit(target, source);
    const e = (
      (
        ((result['a'] as Record<string, unknown>)['b'] as Record<string, unknown>)['c'] as Record<
          string,
          unknown
        >
      )['d'] as Record<string, unknown>
    )['e'] as Record<string, unknown>;
    expect(e['f']).toBe('original');
  });

  test('rejects __proto__ key — does not create own property', () => {
    const r = deepMergeWithDepthLimit({}, JSON.parse('{"__proto__": {"polluted": true}}'));
    expect(Object.keys(r)).not.toContain('__proto__');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('rejects constructor key — does not create own property', () => {
    const r = deepMergeWithDepthLimit({}, { constructor: { polluted: true } });
    expect(Object.keys(r)).not.toContain('constructor');
  });

  test('rejects prototype key — does not create own property', () => {
    const r = deepMergeWithDepthLimit({}, { prototype: { polluted: true } });
    expect(Object.keys(r)).not.toContain('prototype');
  });

  test('rejects pollution keys at nested levels', () => {
    const r = deepMergeWithDepthLimit(
      { o: {} },
      {
        o: { __proto__: { polluted: true }, safe: 'yes' },
      }
    );
    const outer = r['o'] as Record<string, unknown>;
    expect(Object.keys(outer)).not.toContain('__proto__');
    expect(outer['safe']).toBe('yes');
  });

  test('arrays replace (do not merge)', () => {
    expect(deepMergeWithDepthLimit({ items: [1, 2] }, { items: [3, 4] })['items']).toEqual([3, 4]);
  });

  test('null source returns target unchanged', () => {
    expect(deepMergeWithDepthLimit({ a: 1 }, null)).toEqual({ a: 1 });
  });

  test('string source returns target unchanged', () => {
    expect(deepMergeWithDepthLimit({ a: 1 }, 'string')).toEqual({ a: 1 });
  });

  test('array source returns target unchanged', () => {
    expect(deepMergeWithDepthLimit({ a: 1 }, [1, 2, 3])).toEqual({ a: 1 });
  });

  test('number source returns target unchanged', () => {
    expect(deepMergeWithDepthLimit({ a: 1 }, 42)).toEqual({ a: 1 });
  });

  test('modifies target in place and returns it', () => {
    const t: Record<string, unknown> = { a: 1 };
    expect(deepMergeWithDepthLimit(t, { b: 2 })).toBe(t);
  });
});

// ---------------------------------------------------------------------------
// parseJsonStdout
// ---------------------------------------------------------------------------

describe('parseJsonStdout', () => {
  test('parses valid JSON object', () => {
    expect(parseJsonStdout('{"key": "value"}')).toEqual({ key: 'value' });
  });

  test('parses JSON with nested objects', () => {
    expect(parseJsonStdout('{"outer": {"inner": 42}}')).toEqual({ outer: { inner: 42 } });
  });

  test('returns null for empty string', () => {
    expect(parseJsonStdout('')).toBeNull();
  });

  test('returns null for whitespace-only string', () => {
    expect(parseJsonStdout('   \n\t  ')).toBeNull();
  });

  test('returns null for invalid JSON', () => {
    expect(parseJsonStdout('not json')).toBeNull();
  });

  test('returns null for JSON string (not object)', () => {
    expect(parseJsonStdout('"hello"')).toBeNull();
  });

  test('returns null for JSON number (not object)', () => {
    expect(parseJsonStdout('42')).toBeNull();
  });

  test('returns null for JSON null', () => {
    expect(parseJsonStdout('null')).toBeNull();
  });

  test('returns null for JSON array', () => {
    expect(parseJsonStdout('[1, 2, 3]')).toBeNull();
  });

  test('returns null for JSON boolean', () => {
    expect(parseJsonStdout('true')).toBeNull();
  });

  test('ignores trailing whitespace after JSON', () => {
    expect(parseJsonStdout('{"key": "value"}  \n')).toEqual({ key: 'value' });
  });

  test('ignores leading whitespace before JSON', () => {
    expect(parseJsonStdout('  {"key": "value"}')).toEqual({ key: 'value' });
  });

  test('returns empty object for {}', () => {
    expect(parseJsonStdout('{}')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// executeGateScript — integration (uses real Bun.spawn)
// ---------------------------------------------------------------------------

describe('executeGateScript — integration', () => {
  test('successful node script with JSON stdout returns success with data', async () => {
    const r = await executeGateScript(
      {
        interpreter: 'node',
        source: 'console.log(JSON.stringify({ result: "passed", count: 42 }))',
      } as GateScript,
      CTX
    );
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ result: 'passed', count: 42 });
    expect(r.error).toBeUndefined();
  });

  test('successful bash script with JSON stdout returns success with data', async () => {
    const r = await executeGateScript(
      { interpreter: 'bash', source: 'echo \'{"status":"ok"}\'' } as GateScript,
      CTX
    );
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ status: 'ok' });
  });

  test('non-zero exit returns failure with stderr', async () => {
    const r = await executeGateScript(
      { interpreter: 'bash', source: 'echo "error message" >&2; exit 1' } as GateScript,
      CTX
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('error message');
    expect(r.data).toEqual({});
  });

  test('timeout kills process and returns failure', async () => {
    const r = await executeGateScript(
      { interpreter: 'bash', source: 'sleep 10', timeoutMs: 500 } as GateScript,
      CTX
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('timed out');
    expect(r.error).toContain('500ms');
    expect(r.data).toEqual({});
  });

  test('empty stdout returns success with empty data', async () => {
    const r = await executeGateScript({ interpreter: 'bash', source: 'true' } as GateScript, CTX);
    expect(r.success).toBe(true);
    expect(r.data).toEqual({});
    expect(r.error).toBeUndefined();
  });

  test('non-JSON stdout returns success with empty data', async () => {
    const r = await executeGateScript(
      { interpreter: 'bash', source: 'echo "not json"' } as GateScript,
      CTX
    );
    expect(r.success).toBe(true);
    expect(r.data).toEqual({});
  });

  test('unknown interpreter returns failure', async () => {
    const r = await executeGateScript(
      { interpreter: 'ruby', source: 'puts "hello"' } as GateScript,
      CTX
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('Unknown interpreter');
  });

  test('spawn failure (missing interpreter) returns failure without crashing', async () => {
    const r = await executeGateScript(
      { interpreter: 'node', source: 'console.log(1)' } as GateScript,
      { ...CTX, workspacePath: '/nonexistent/path/that/does/not/exist' }
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('Failed to spawn');
    expect(r.data).toEqual({});
  });
  test('restricted env does not leak credentials to script', async () => {
    const origKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-secret';
    try {
      const r = await executeGateScript(
        {
          interpreter: 'node',
          source: 'console.log(JSON.stringify({ key: process.env.ANTHROPIC_API_KEY }))',
        } as GateScript,
        CTX
      );
      expect(r.success).toBe(true);
      expect(r.data['key']).toBeUndefined();
    } finally {
      if (origKey === undefined) {
        delete process.env['ANTHROPIC_API_KEY'];
      } else {
        process.env['ANTHROPIC_API_KEY'] = origKey;
      }
    }
  });

  test('restricted env does not leak NEOKAI_ internal vars', async () => {
    const origPort = process.env['NEOKAI_PORT'];
    process.env['NEOKAI_PORT'] = '9999';
    try {
      const r = await executeGateScript(
        {
          interpreter: 'node',
          source: 'console.log(JSON.stringify({ port: process.env.NEOKAI_PORT }))',
        } as GateScript,
        CTX
      );
      expect(r.success).toBe(true);
      expect(r.data['port']).toBeUndefined();
    } finally {
      if (origPort === undefined) {
        delete process.env['NEOKAI_PORT'];
      } else {
        process.env['NEOKAI_PORT'] = origPort;
      }
    }
  });

  test('injects NEOKAI_GATE_ID into script env', async () => {
    const r = await executeGateScript(
      {
        interpreter: 'node',
        source: 'console.log(JSON.stringify({ gateId: process.env.NEOKAI_GATE_ID }))',
      } as GateScript,
      CTX
    );
    expect(r.success).toBe(true);
    expect(r.data['gateId']).toBe('gate-123');
  });

  test('injects NEOKAI_WORKFLOW_RUN_ID into script env', async () => {
    const r = await executeGateScript(
      {
        interpreter: 'node',
        source: 'console.log(JSON.stringify({ runId: process.env.NEOKAI_WORKFLOW_RUN_ID }))',
      } as GateScript,
      CTX
    );
    expect(r.success).toBe(true);
    expect(r.data['runId']).toBe('run-456');
  });

  test('injects NEOKAI_WORKSPACE_PATH into script env', async () => {
    const r = await executeGateScript(
      {
        interpreter: 'node',
        source: 'console.log(JSON.stringify({ ws: process.env.NEOKAI_WORKSPACE_PATH }))',
      } as GateScript,
      CTX
    );
    expect(r.success).toBe(true);
    expect(r.data['ws']).toBe('/tmp');
  });

  test('injects NEOKAI_GATE_DATA_JSON into script env (no field aliases)', async () => {
    const r = await executeGateScript(
      {
        interpreter: 'node',
        source:
          'console.log(JSON.stringify({ gateData: process.env.NEOKAI_GATE_DATA_JSON, prAlias: process.env.NEOKAI_GATE_PR_URL ?? null }))',
      } as GateScript,
      {
        ...CTX,
        gateData: { pr_url: 'https://github.com/example/repo/pull/42', approved: true },
      }
    );
    expect(r.success).toBe(true);
    expect(r.data['gateData']).toBe(
      '{"pr_url":"https://github.com/example/repo/pull/42","approved":true}'
    );
    expect(r.data['prAlias']).toBeNull();
  });

  test('JSON stdout with prototype pollution keys is sanitized', async () => {
    const r = await executeGateScript(
      {
        interpreter: 'node',
        source: `console.log(JSON.stringify({
					"__proto__": { "polluted": true },
					"constructor": { "polluted": true },
					"safe_key": "safe_value"
				}))`,
      } as GateScript,
      CTX
    );
    expect(r.success).toBe(true);
    expect(r.data['safe_key']).toBe('safe_value');
    expect(Object.keys(r.data)).not.toContain('__proto__');
    expect(Object.keys(r.data)).not.toContain('constructor');
  });

  test('deep-merges nested JSON stdout', async () => {
    const r = await executeGateScript(
      {
        interpreter: 'node',
        source: `console.log(JSON.stringify({
					"level1": { "level2": { "value": "deep" } }
				}))`,
      } as GateScript,
      CTX
    );
    expect(r.success).toBe(true);
    expect((r.data['level1'] as Record<string, unknown>)['level2']).toEqual({ value: 'deep' });
  });

  test('uses default timeout when not specified', async () => {
    const start = Date.now();
    const r = await executeGateScript(
      { interpreter: 'bash', source: 'echo \'{"fast": true}\'' } as GateScript,
      CTX
    );
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ fast: true });
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test('non-zero exit with empty stderr uses fallback message', async () => {
    const r = await executeGateScript(
      { interpreter: 'bash', source: 'exit 42' } as GateScript,
      CTX
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain('42');
  });

  test('maxBuffer enforcement: script outputting >1MB does not crash', async () => {
    // Generate a JSON payload larger than 1MB (MAX_BUFFER_BYTES = 1_048_576).
    // The output will be truncated by collectWithMaxBuffer at a byte boundary.
    // Truncation does NOT guarantee invalid JSON (a cut after `}` would still parse),
    // but with this specific payload ({ data: 'x'.repeat(2_000_000) }) the truncated
    // prefix is almost certainly missing its closing braces, so parseJsonStdout returns null.
    const r = await executeGateScript(
      {
        interpreter: 'node',
        source: `
					const big = { data: 'x'.repeat(2_000_000) };
					console.log(JSON.stringify(big));
				`,
      } as GateScript,
      CTX
    );
    // Should not crash — process exits 0, truncated stdout fails JSON parse → empty data
    expect(r.success).toBe(true);
    expect(r.data).toEqual({});
  });

  test('maxBuffer enforcement: script outputting >1MB of plain text succeeds with empty data', async () => {
    // Output >1MB of plain text (not JSON) — should still succeed with empty data
    const r = await executeGateScript(
      {
        interpreter: 'bash',
        source: `dd if=/dev/urandom bs=1024 count=2048 2>/dev/null | base64`,
      } as GateScript,
      CTX
    );
    // Plain text output, possibly truncated, but exit 0 → success with empty data
    expect(r.success).toBe(true);
    expect(r.data).toEqual({});
  });

  test('maxBuffer enforcement: stderr exceeding 1MB is truncated to boundary', async () => {
    // Script exits non-zero with >1MB stderr (base64-encoded 2MB random data produces
    // ~2.7MB of text). The truncated stderr is used as the error message.
    const r = await executeGateScript(
      {
        interpreter: 'bash',
        source: `dd if=/dev/urandom bs=1024 count=2048 2>/dev/null | base64 >&2; exit 1`,
      } as GateScript,
      CTX
    );
    expect(r.success).toBe(false);
    expect(r.error).toBeDefined();
    // Truncation should have fired: stderr must be non-empty and at the exact 1MB cap
    expect(r.error!.length).toBeGreaterThan(0);
    expect(r.error!.length).toBe(1_048_576);
  });

  test('workspacePath is set as cwd for bash script', async () => {
    const r = await executeGateScript(
      {
        interpreter: 'bash',
        source: `echo '{"cwd": "'$(pwd)'"}'`,
      } as GateScript,
      CTX
    );
    expect(r.success).toBe(true);
    expect(r.data['cwd']).toBe(realpathSync('/tmp'));
  });

  test('workspacePath is set as cwd for node script', async () => {
    const r = await executeGateScript(
      {
        interpreter: 'node',
        source: 'console.log(JSON.stringify({ cwd: process.cwd() }))',
      } as GateScript,
      CTX
    );
    expect(r.success).toBe(true);
    expect(r.data['cwd']).toBe(realpathSync('/tmp'));
  });
});

// ---------------------------------------------------------------------------
// executeGateScript — python3 (if available)
// ---------------------------------------------------------------------------

describe('executeGateScript — python3', () => {
  test('successful python3 script with JSON stdout', async () => {
    if (!(await isPython3Available())) {
      console.log('[SKIP] python3 not available on this system');
      return;
    }

    const r = await executeGateScript(
      {
        interpreter: 'python3',
        source: 'import json; print(json.dumps({"python": True}))',
      } as GateScript,
      CTX
    );
    expect(r.success).toBe(true);
    expect(r.data['python']).toBe(true);
  });

  test('workspacePath is set as cwd for python3 script', async () => {
    if (!(await isPython3Available())) {
      console.log('[SKIP] python3 not available on this system');
      return;
    }

    const r = await executeGateScript(
      {
        interpreter: 'python3',
        source: 'import json, os; print(json.dumps({"cwd": os.getcwd()}))',
      } as GateScript,
      CTX
    );
    expect(r.success).toBe(true);
    expect(r.data['cwd']).toBe(realpathSync('/tmp'));
  });
});
