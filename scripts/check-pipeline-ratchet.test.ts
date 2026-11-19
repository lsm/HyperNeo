import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countPipelineRoutes } from './system-map.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(initialMissing = false) {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-ratchet-'));
  roots.push(root);
  const put = (path: string, text: string) => {
    const file = join(root, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  };
  put(
    'packages/demo/src/main.ts',
    `
    const run = superpipe({})('demo.run').end();
    defineOperation({ name: 'demo.run', execute: () => run() });
    transport.onRequest('demo.run', () => {});
  `
  );
  put(
    'scripts/pipeline-ratchet-baseline.json',
    JSON.stringify({ missing: initialMissing ? 1 : 0, misnamed: 0, dynamic: 0, unreadable: 0 })
  );
  if (initialMissing)
    put('packages/demo/src/extra.ts', `defineOperation({ name: 'demo.extra', execute: () => 1 });`);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git('init', '-q');
  git('add', '.');
  const tree = git('write-tree');
  const commit = git('commit-tree', tree, '-m', 'fixture');
  git('update-ref', 'HEAD', commit);
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, 'check-pipeline-ratchet.ts'), root, 'HEAD', ...args],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  };
  return { put, run };
}

test('the check passes at baseline', () => {
  const f = fixture();
  expect(f.run().code).toBe(0);
});

test.each([
  ['missing', `defineOperation({ name: 'demo.missing', execute: () => 1 });`],
  [
    'misnamed',
    `const other = superpipe({})('wrong.name').end(); defineOperation({ name: 'demo.other', execute: () => other() });`,
  ],
  ['dynamic', `transport.onRequest(methodName, () => {});`],
  ['dynamic', `const route = superpipe({})(makeName()).end();`],
  ['dynamic', `transport.onRequest('demo.' + suffix, () => {});`],
  ['unreadable', `defineOperation({ name: 'demo.unknown', execute: externalHandler });`],
])('the check fails when %s increases', (kind, source) => {
  const f = fixture();
  f.put('packages/demo/src/added.ts', source);
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain(kind);
});

test('raising the baseline cannot hide a regression', () => {
  const f = fixture();
  f.put('packages/demo/src/added.ts', `transport.onRequest(methodName, () => {});`);
  f.put(
    'scripts/pipeline-ratchet-baseline.json',
    JSON.stringify({ missing: 0, misnamed: 0, dynamic: 1, unreadable: 0 })
  );
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain('baseline may only decrease');
});

test('a malformed baseline fails closed', () => {
  const f = fixture();
  f.put('scripts/pipeline-ratchet-baseline.json', '{}');
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain('Invalid pipeline ratchet baseline');
});

test('a pipeline in another function cannot hide an unreadable route', () => {
  const f = fixture();
  f.put(
    'packages/demo/src/added.ts',
    `
    function unrelated() { const run = superpipe({})('demo.hidden').end(); }
    function operation(run) { return defineOperation({ name: 'demo.hidden', execute: () => run() }); }
  `
  );
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain('unreadable');
});

test.each([
  'condition && run()',
  'condition ? run() : fallback()',
  'queue(() => run())',
  'run?.()',
  'options?.[run()]',
  'options?.method(run())',
])('a conditional or deferred pipeline call stays unreadable: %s', (expression) => {
  const source = `import superpipe from 'superpipe';
    import { defineOperation } from './registry.ts';
    const run = superpipe({})('demo.maybe').end();
    defineOperation({ name: 'demo.maybe', execute: () => ${expression} });`;
  expect(
    countPipelineRoutes(new Map([['packages/demo/src/added.ts', source]]), true).unreadable
  ).toBe(1);
});

test('an unconditional pipeline call remains readable beside an optional access', () => {
  const source = `import superpipe from 'superpipe';
    import { defineOperation } from './registry.ts';
    const run = superpipe({})('demo.maybe').end();
    defineOperation({ name: 'demo.maybe', execute: () => [run(), options?.[run()]] });`;
  expect(
    countPipelineRoutes(new Map([['packages/demo/src/added.ts', source]]), true).unreadable
  ).toBe(0);
});

test.each(['run() ?? fallback()', 'run() || fallback()', 'run() && fallback()'])(
  'a pipeline call on the left of a short-circuit expression is readable: %s',
  (expression) => {
    const source = `import superpipe from 'superpipe';
      import { defineOperation } from './registry.ts';
      const run = superpipe({})('demo.maybe').end();
      defineOperation({ name: 'demo.maybe', execute: () => ${expression} });`;
    expect(
      countPipelineRoutes(new Map([['packages/demo/src/added.ts', source]]), true).unreadable
    ).toBe(0);
  }
);

test.each([
  `() => { const inner = superpipe({})('demo.maybe').end(); return condition ? inner() : null; }`,
  `() => condition && superpipe({})('demo.maybe').end()()`,
  `() => { const inner = superpipe({})('demo.maybe').end(); return queue(() => inner()); }`,
])('a conditional inline pipeline stays unreadable: %s', (execute) => {
  const source = `import superpipe from 'superpipe';
    import { defineOperation } from './registry.ts';
    defineOperation({ name: 'demo.maybe', execute: ${execute} });`;
  expect(
    countPipelineRoutes(new Map([['packages/demo/src/added.ts', source]]), true).unreadable
  ).toBe(1);
});

test('an optional pipeline call inside a helper stays unreadable', () => {
  const source = `import superpipe from 'superpipe';
    import { defineOperation } from './registry.ts';
    const run = superpipe({})('demo.maybe').end();
    const helper = () => run?.();
    defineOperation({ name: 'demo.maybe', execute: () => helper() });`;
  expect(
    countPipelineRoutes(new Map([['packages/demo/src/added.ts', source]]), true).unreadable
  ).toBe(1);
});

test('an early return before a pipeline call stays unreadable', () => {
  const source = `const run = superpipe({})('demo.maybe').end();
    defineOperation({ name: 'demo.maybe', execute: () => { if (condition) return; return run(); } });`;
  expect(
    countPipelineRoutes(new Map([['packages/demo/src/added.ts', source]]), true).unreadable
  ).toBe(1);
});

test('a direct pipeline call inside a try-return stays readable', () => {
  const source = `const run = superpipe({})('demo.try').end();
    defineOperation({ name: 'demo.try', execute: async () => { try { return await run(); } catch { return null; } } });`;
  expect(
    countPipelineRoutes(new Map([['packages/demo/src/added.ts', source]]), true).unreadable
  ).toBe(0);
});

test.each(['service.run()', 'service?.run()', '({...service.run()})'])(
  'a member call %s cannot be mistaken for a local pipeline',
  (call) => {
    const f = fixture();
    f.put(
      'packages/demo/src/added.ts',
      `
      const run = superpipe({})('demo.member').end();
      defineOperation({ name: 'demo.member', execute: () => ${call} });
    `
    );
    const result = f.run();
    expect(result.code).toBe(1);
    expect(result.output).toContain('unreadable: 1 (baseline 0)');
  }
);

test.each(['[...run()]', '({...run()})', 'collect(...run())'])(
  'a direct pipeline call inside spread %s remains readable',
  (expression) => {
    const f = fixture();
    f.put(
      'packages/demo/src/added.ts',
      `
      const run = superpipe({})('demo.spread').end();
      defineOperation({ name: 'demo.spread', execute: () => ${expression} });
    `
    );
    expect(f.run().code).toBe(0);
  }
);

test.each([
  `function setup(run) { return defineOperation({ name: 'demo.shadow', execute: () => run() }); }`,
  `function setup(run: Handler): Result { return defineOperation({ name: 'demo.shadow', execute: run }); }`,
  `function setup({ run }) { return defineOperation({ name: 'demo.shadow', execute: () => run() }); }`,
  `defineOperation({ name: 'demo.shadow', execute: (run) => run() });`,
])('a parameter shadow cannot be mistaken for an outer pipeline: %s', (operation) => {
  const f = fixture();
  f.put(
    'packages/demo/src/added.ts',
    `const run = superpipe({})('demo.shadow').end(); ${operation}`
  );
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain('unreadable: 1 (baseline 0)');
});

test('a pipeline declared inside an outer parameter scope is still readable', () => {
  const f = fixture();
  f.put(
    'packages/demo/src/added.ts',
    `
    function outer(run) {
      function inner() {
        const run = superpipe({})('demo.inner').end();
        return defineOperation({ name: 'demo.inner', execute: () => run() });
      }
    }
  `
  );
  expect(f.run().code).toBe(0);
});

test.each([
  `function setup() { const run = handler; return defineOperation({ name: 'demo.shadow', execute: () => run() }); }`,
  `function setup() { let run = handler; return defineOperation({ name: 'demo.shadow', execute: run }); }`,
  `function setup() { { var run = handler; } return defineOperation({ name: 'demo.shadow', execute: () => run() }); }`,
  `function setup() { const { run } = handlers; return defineOperation({ name: 'demo.shadow', execute: () => run() }); }`,
  `defineOperation({ name: 'demo.shadow', execute: () => { const run = handler; return run(); } });`,
  `function setup() { try {} catch (run) { return defineOperation({ name: 'demo.shadow', execute: () => run() }); } }`,
  `function setup() { for (const run of handlers) { return defineOperation({ name: 'demo.shadow', execute: () => run() }); } }`,
  `function setup() { function run() {} return defineOperation({ name: 'demo.shadow', execute: () => run() }); }`,
  `function setup() { class run {} return defineOperation({ name: 'demo.shadow', execute: () => new run() }); }`,
])('a local binding cannot be mistaken for an outer pipeline: %s', (operation) => {
  const f = fixture();
  f.put(
    'packages/demo/src/added.ts',
    `const run = superpipe({})('demo.shadow').end(); ${operation}`
  );
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain('unreadable: 1 (baseline 0)');
});

test('a binding in a sibling block does not shadow an outer pipeline', () => {
  const f = fixture();
  f.put(
    'packages/demo/src/added.ts',
    `
    const run = superpipe({})('demo.outer').end();
    function setup() {
      { const run = handler; }
      return defineOperation({ name: 'demo.outer', execute: () => run() });
    }
  `
  );
  expect(f.run().code).toBe(0);
});

test.each([
  `const alias = run; defineOperation({ name: 'demo.local', execute: alias });`,
  `const helper = () => run(); defineOperation({ name: 'demo.local', execute: () => helper() });`,
])('a proven local alias or helper reaches the named pipeline: %s', (operation) => {
  const f = fixture();
  f.put(
    'packages/demo/src/added.ts',
    `
    import superpipe from 'superpipe';
    import { defineOperation } from './registry.ts';
    const run = superpipe({})('demo.local').end();
    ${operation}
  `
  );
  expect(f.run().code).toBe(0);
});

test('a local alias to a differently named pipeline stays unreadable', () => {
  const f = fixture();
  f.put(
    'packages/demo/src/added.ts',
    `
    import superpipe from 'superpipe';
    import { defineOperation } from './registry.ts';
    const run = superpipe({})('demo.other').end();
    const alias = run;
    defineOperation({ name: 'demo.local', execute: alias });
  `
  );
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain('unreadable: 1 (baseline 0)');
});

test('a forwarded name is unreadable rather than a constructed name', () => {
  const f = fixture();
  f.put(
    'packages/demo/src/added.ts',
    `function forward(method, handler) { transport.onRequest(method, handler); }`
  );
  const result = f.run();
  expect(result.code).toBe(1);
  expect(result.output).toContain('unreadable: 1 (baseline 0)');
  expect(result.output).toContain('dynamic: 0 (baseline 0)');
});

test('a decrease requires lowering the baseline', () => {
  const f = fixture(true);
  f.put('packages/demo/src/extra.ts', '');
  expect(f.run().code).toBe(1);
  expect(f.run('--update').code).toBe(0);
  expect(f.run().code).toBe(0);
});

test('update cannot hide an increase', () => {
  const f = fixture();
  f.put('packages/demo/src/added.ts', `transport.onRequest(methodName, () => {});`);
  expect(f.run('--update').code).toBe(1);
});
