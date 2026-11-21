import { expect, test } from 'bun:test';
import { createLocalPipelineResolver } from './pipeline-route-resolver.ts';
import { countPipelineRoutes } from './system-map.ts';

const resolveLocalPipeline = (source: string, name: string) =>
  createLocalPipelineResolver(source)(name);

const imports = `
  import superpipe from 'superpipe';
  import { defineOperation } from './registry.ts';
`;
const runner = `const run = superpipe({})('demo.read').input('input').endAsync('input');`;

test.each([
  [
    'identifier argument',
    'const make = () => ({ go: (input) => run(input) });',
    'make().go(input)',
    'named',
  ],
  [
    'opaque argument',
    'const make = () => ({ go: (input) => run(input) });',
    'make().go(sideEffect())',
    'unknown',
  ],
  [
    'shadowed runner argument',
    'const make = () => ({ go: (run) => run() });',
    'make().go(input)',
    'unknown',
  ],
  [
    'default parameter',
    'const make = () => ({ go: (input = sideEffect()) => run(input) });',
    'make().go(input)',
    'unknown',
  ],
  [
    'destructured parameter',
    'const make = () => ({ go: ({input}) => run(input) });',
    'make().go(input)',
    'unknown',
  ],
  [
    'spread argument',
    'const make = () => ({ go: (input) => run(input) });',
    'make().go(...input)',
    'unknown',
  ],
  [
    'unbound global argument',
    'const make = () => ({ go: (input) => run(input) });',
    'make().go(globalInput)',
    'unknown',
  ],
  ['mutable factory', 'let make = () => ({ go: () => run() });', 'make().go()', 'unknown'],
  ['block body', 'const make = () => { return { go: () => run() }; };', 'make().go()', 'named'],
  ['async factory', 'const make = async () => ({ go: () => run() });', 'make().go()', 'unknown'],
  [
    'awaited async factory with arguments',
    'const make = async (value) => ({ go: (item) => run(item) });',
    '(await make(input)).go(input)',
    'named',
  ],
  [
    'awaited factory with effectful argument',
    'const make = async (value) => ({ go: (item) => run(item) });',
    '(await make(sideEffect())).go(input)',
    'unknown',
  ],
  [
    'awaited factory with unbound argument',
    'const make = async (value) => ({ go: (item) => run(item) });',
    '(await make(globalInput)).go(input)',
    'unknown',
  ],
  [
    'awaited factory with runner parameter shadow',
    'const make = async (run) => ({ go: (item) => run(item) });',
    '(await make(input)).go(input)',
    'unknown',
  ],
  [
    'async factory thenable',
    'const make = async () => ({ then: () => run() });',
    '(await make()).then()',
    'unknown',
  ],
  [
    'awaited synchronous factory',
    'const make = () => ({ go: () => run() });',
    '(await make()).go()',
    'unknown',
  ],
  [
    'method shorthand',
    'const make = () => ({ go() { return run(); } });',
    'make().go()',
    'unknown',
  ],
  ['getter', 'const make = () => ({ get go() { return run; } });', 'make().go()', 'unknown'],
  ['shadowed runner', 'const make = () => ({ go: (run) => run() });', 'make().go()', 'unknown'],
  [
    'extra property',
    'const make = () => ({ go: () => run(), other: sideEffect() });',
    'make().go()',
    'unknown',
  ],
  ['direct returned method', 'const make = () => ({ go: () => run() });', 'make().go()', 'named'],
  [
    'conditional factory',
    'const make = () => condition ? { go: () => run() } : {};',
    'make().go()',
    'unknown',
  ],
  [
    'spread method',
    'const make = () => ({ go: () => run(), ...other });',
    'make().go()',
    'unknown',
  ],
  [
    'computed method',
    'const make = () => ({ go: () => run(), [key]: fallback });',
    'make().go()',
    'unknown',
  ],
  [
    'duplicate method',
    'const make = () => ({ go: () => run(), go: () => fallback() });',
    'make().go()',
    'unknown',
  ],
  [
    'parameterized factory',
    'const make = (run) => ({ go: () => run() });',
    'make().go()',
    'unknown',
  ],
  ['optional method', 'const make = () => ({ go: () => run() });', 'make()?.go()', 'unknown'],
  [
    'recursive factory method',
    'const make = () => ({ go: () => make().go() });',
    'make().go()',
    'unknown',
  ],
] as const)('strictly traces a %s', (_label, definition, execute, kind) => {
  const source = `${imports} ${runner} ${definition}
    defineOperation({ name: 'demo.read', execute: (input) => ${execute} });`;
  expect(createLocalPipelineResolver(source, 'route.ts', true)('demo.read')).toEqual(
    kind === 'named' ? { kind, name: 'demo.read' } : { kind }
  );
});

const serialQueue = `
 let pending = Promise.resolve();
 const serialize = (action) => {
   const result = pending.then(action);
   pending = result.then(() => undefined, () => undefined);
   return result;
 };
`;

test.each([
  ['canonical queue', serialQueue, 'named'],
  ['skipped callback', serialQueue.replace('then(action)', 'then(() => null)'), 'unknown'],
  ['cursor replaced', `${serialQueue} pending = neverSettles;`, 'unknown'],
  ['shadowed Promise', `const Promise = customPromise; ${serialQueue}`, 'unknown'],
  ['patched Promise', `Promise.resolve = customResolve; ${serialQueue}`, 'unknown'],
  ['dynamic evaluation', `${serialQueue} (eval)('pending = custom');`, 'unknown'],
  ['competing recovery', serialQueue.replace('() => undefined);', '() => otherRun());'), 'unknown'],
  ['nested queue', serialQueue, 'unknown', 'serialize(() => run())'],
] as const)('strictly follows a queue with %s', (_title, queue, kind, action = 'run()') => {
  const source = `${imports} ${runner} ${queue}
    defineOperation({ name: 'demo.read', execute: () => serialize(() => ${action}) });`;
  expect(createLocalPipelineResolver(source, 'route.ts', true)('demo.read')).toEqual(
    kind === 'named' ? { kind, name: 'demo.read' } : { kind }
  );
});

test.each([
  [runner, 'run'],
  [runner, '() => run()'],
  [`${runner} const alias = run;`, 'alias'],
  [`${runner} const helper = () => run();`, '() => helper()'],
  [`${runner} const helper = async () => { return await run(); };`, 'helper'],
])('resolves an unconditional local pipeline through %s', (declarations, execute) => {
  const source = `${imports} ${declarations} defineOperation({ name: 'demo.read', execute: ${execute} });`;
  expect(resolveLocalPipeline(source, 'demo.read')).toEqual({ kind: 'named', name: 'demo.read' });
});

test.each([
  [runner, '() => condition && run()'],
  [runner, '() => { if (condition) return run(); return null; }'],
  [runner, '() => run'],
  [runner, '() => queue(() => run())'],
  [`${runner} let handler = run;`, 'handler'],
  [`${runner} const handler = (run) => run();`, 'handler'],
  [`${runner} const handler = () => handler();`, 'handler'],
  [`${runner} const factory = () => run;`, 'factory()'],
  [`import { handler } from './external.ts';`, 'handler'],
  [`const run = superpipe({})(name).end();`, 'run'],
])('leaves ambiguous local routes unknown through %s', (declarations, execute) => {
  const source = `${imports} ${declarations} defineOperation({ name: 'demo.read', execute: ${execute} });`;
  expect(resolveLocalPipeline(source, 'demo.read')).toEqual({ kind: 'unknown' });
});

test.each([
  [
    'builder',
    "function finish(builder) { return (builder as PipelineAPI).input('input').endAsync('input'); }",
    "finish(superpipe({})('demo.read'))",
    'named',
  ],
  [
    'helper chain',
    "const addInput = (builder) => builder.input('input'); const configure = (builder) => addInput(builder);",
    '((input) => (run as Run)(input))',
    'named',
  ],
  [
    'unfinished builder',
    "const wrap = (builder) => builder.input('input');",
    "wrap(superpipe({})('demo.read'))",
    'unknown',
  ],
  [
    'reassigned helper',
    'function finish(builder) { return builder.end(); } ({ finish } = replacements);',
    "finish(superpipe({})('demo.read'))",
    'unknown',
  ],
  [
    'untrusted builder',
    'const finish = (builder) => builder.end();',
    "finish(other({})('demo.read'))",
    'unknown',
  ],
  [
    'literal default',
    'const finish = (builder, enabled = true) => builder.end();',
    "finish(superpipe({})('demo.read'))",
    'named',
  ],
  [
    'default with an effect',
    'const finish = (builder, enabled = reconfigure()) => builder.end();',
    "finish(superpipe({})('demo.read'))",
    'unknown',
  ],
  [
    'conditional helper',
    'const finish = (builder) => ready ? builder.end() : other;',
    "finish(superpipe({})('demo.read'))",
    'unknown',
  ],
])(
  'strict resolution follows only a finished builder through %s',
  (testCase, helpers, execute, kind) => {
    const setup =
      testCase === 'helper chain' ? "const run = configure(superpipe({})('demo.read')).end();" : '';
    const source = `${imports} ${helpers} ${setup} defineOperation({ name: 'demo.read', execute: ${execute} });`;
    const result = createLocalPipelineResolver(source, 'route.ts', true)('demo.read');
    expect(result).toEqual(kind === 'named' ? { kind, name: 'demo.read' } : { kind });
  }
);

test('does not count a shadowed superpipe import as a pipeline', () => {
  const source = `${imports}
    function setup(superpipe) {
      const run = superpipe({})('demo.read').end();
      return defineOperation({ name: 'demo.read', execute: run });
    }
  `;
  expect(resolveLocalPipeline(source, 'demo.read')).toEqual({ kind: 'unknown' });
});

test('leaves duplicate operation definitions unknown', () => {
  const source = `${imports} ${runner}
    defineOperation({ name: 'demo.read', execute: run });
    defineOperation({ name: 'demo.read', execute: run });
  `;
  expect(resolveLocalPipeline(source, 'demo.read')).toEqual({ kind: 'unknown' });
});

test.each([
  ['', 'named'],
  ['({ make } = other);', 'unknown'],
  ['eval("make = other");', 'unknown'],
])('strict follows a stable, directly exported pipeline factory with %s', (extra, kind) => {
  const source = `
    import { make as factory } from './factory.ts';
    import { defineOperation } from './registry';
    const run = factory(deps);
    defineOperation({ name: 'demo.read', execute: () => run() });
  `;
  const target = `
    import builder from 'superpipe';
    export function make(deps) { return builder({ deps })('demo.read').endAsync(); }
    ${extra}
  `;
  const resolve = createLocalPipelineResolver(
    source,
    'packages/demo/src/operations.ts',
    true,
    (file) => (file === 'packages/demo/src/factory.ts' ? target : undefined)
  );
  expect(resolve('demo.read')).toEqual(kind === 'named' ? { kind, name: 'demo.read' } : { kind });
});

test('strict does not trust a factory parameter that shadows the pipeline import', () => {
  const resolve = createLocalPipelineResolver(
    `import { make } from './factory.ts';
     import { defineOperation } from './registry';
     defineOperation({ name: 'demo.read', execute: make(deps) });`,
    'packages/demo/src/operations.ts',
    true,
    () => `import builder from 'superpipe';
           export function make(builder) { return builder({})('demo.read').end(); }`
  );
  expect(resolve('demo.read')).toEqual({ kind: 'unknown' });
});

test('returns the actual pipeline name for a mismatched operation', () => {
  const source = `${imports} ${runner} defineOperation({ name: 'demo.other', execute: run });`;
  expect(resolveLocalPipeline(source, 'demo.other')).toEqual({ kind: 'named', name: 'demo.read' });
});

test('reuses one resolver across multiple operations without leaking resolution state', () => {
  const source = `${imports} ${runner}
    const alias = run;
    defineOperation({ name: 'demo.first', execute: alias });
    defineOperation({ name: 'demo.second', execute: () => alias() });
    defineOperation({ name: 'demo.ambiguous', execute: alias });
    defineOperation({ name: 'demo.ambiguous', execute: alias });
  `;
  const resolve = createLocalPipelineResolver(source);
  expect(resolve('demo.first')).toEqual({ kind: 'named', name: 'demo.read' });
  expect(resolve('demo.second')).toEqual({ kind: 'named', name: 'demo.read' });
  expect(resolve('demo.ambiguous')).toEqual({ kind: 'unknown' });
  expect(resolve('demo.missing')).toEqual({ kind: 'unknown' });
  expect(resolve('demo.first')).toEqual({ kind: 'named', name: 'demo.read' });
});

test('resolves a literal name passed to a local pipeline factory', () => {
  const source = `${imports}
    const make = (label, action) => superpipe({})(label).input('input').pipe(action, 'input', 'output').end('output');
    defineOperation({ name: 'demo.read', execute: make('demo.read', run) });
    defineOperation({ name: 'demo.other', execute: make('demo.read', run) });
  `;
  const resolve = createLocalPipelineResolver(source);
  expect(resolve('demo.read')).toEqual({ kind: 'named', name: 'demo.read' });
  expect(resolve('demo.other')).toEqual({ kind: 'named', name: 'demo.read' });
});

test.each([
  ['const make = (label) => superpipe({})(label).end();', 'make(name)'],
  ['let make = (label) => superpipe({})(label).end();', "make('demo.read')"],
  ['const make = (label = "demo.read") => superpipe({})(label).end();', 'make()'],
  [
    'const make = (label) => { sideEffect(); return superpipe({})(label).end(); };',
    "make('demo.read')",
  ],
  ['const make = (label) => superpipe({})(other).end();', "make('demo.read')"],
  ['const make = (label) => superpipe({ x: label = "other" })(label).end();', "make('demo.read')"],
  ['const make = async (label) => superpipe({})(label).end();', "make('demo.read')"],
])('leaves unproven factory routes unknown through %s', (declarations, execute) => {
  const source = `${imports} ${declarations} defineOperation({ name: 'demo.read', execute: ${execute} });`;
  expect(resolveLocalPipeline(source, 'demo.read')).toEqual({ kind: 'unknown' });
});

test('strict resolution follows a local function that returns a named runner', () => {
  const source = `${imports}
    function setup() {
      function path<T>(name: string, action: (input: T) => T) {
        return (superpipe({})(name) as PipelineAPI).input('input').pipe(action, 'input', 'output').endAsync('output');
      }
      return defineOperation({ name: 'demo.read', execute: path('demo.read', run) });
    }
  `;
  expect(createLocalPipelineResolver(source, 'route.ts', true)('demo.read')).toEqual({
    kind: 'named',
    name: 'demo.read',
  });
});

test.each(['path = other;', '({ path } = handlers);', 'eval("path = other");'])(
  'strict resolution rejects a local factory that can be replaced through %s',
  (replace) => {
    const source = `${imports}
      function setup() {
        function path(name) { return superpipe({})(name).end(); }
        ${replace}
        return defineOperation({ name: 'demo.read', execute: path('demo.read') });
      }
    `;
    expect(createLocalPipelineResolver(source, 'route.ts', true)('demo.read')).toEqual({
      kind: 'unknown',
    });
  }
);

const dbDirectory = 'packages/daemon/src/storage/db-gateway';
const workerSource = new Map([
  [
    `${dbDirectory}/db-gateway-worker.ts`,
    `import { DB_OPS } from './db-ops.ts';
    const command = DB_OPS.get(name);
    if (!command) throw new Error('unknown operation');
    command.run(db, args, changes);`,
  ],
  [
    `${dbDirectory}/db-ops.ts`,
    `import { query } from './read.ts';
    export const DB_OPS = new Map([query].map((op) => [op.name, op]));`,
  ],
  [
    `${dbDirectory}/read.ts`,
    `import { defineRepositoryOp } from './db-op.ts';
    import { runQuery } from './query.ts';
    class Query {
      read(input) { return runQuery(input); }
    }
    export const query = defineRepositoryOp('domain.query', 'read', Query, ['read']);`,
  ],
  [
    `${dbDirectory}/other.ts`,
    `import { defineDbOp } from './db-op.ts';
    export const other = defineDbOp({ name: 'domain.query', mode: 'read', run: () => 0 });`,
  ],
  [
    `${dbDirectory}/query.ts`,
    `import superpipe from 'superpipe';
    export const runQuery = superpipe({})('demo.read').input('input').end('input');`,
  ],
]);

test.each([
  ['registered method', 'db(database).call(query, "read", input)', undefined, 'named'],
  ['dynamic method', 'db(database).call(query, method, input)', undefined, 'unknown'],
  ['dynamic command', 'db(database).call(command, "read", input)', undefined, 'unknown'],
  [
    'unregistered command',
    'db(database).call(query, "read", input)',
    ['db-ops.ts', '[query]', '[]'],
    'unknown',
  ],
  [
    'unlisted method',
    'db(database).call(query, "read", input)',
    ['read.ts', "['read']", "['write']"],
    'unknown',
  ],
  [
    'shadowed registration key',
    'db(database).call(query, "read", input)',
    [
      'db-ops.ts',
      'export const DB_OPS = new Map([query]',
      "import { other } from './other.ts'; export const DB_OPS = new Map([query, other]",
    ],
    'unknown',
  ],
  [
    'registry mutation',
    'db(database).call(query, "read", input)',
    ['db-ops.ts', '[op.name, op]));', '[op.name, op])); DB_OPS.clear();'],
    'unknown',
  ],
  [
    'registry alias in the same declaration',
    'db(database).call(query, "read", input)',
    ['db-ops.ts', '[op.name, op]));', '[op.name, op])), alias = DB_OPS;'],
    'unknown',
  ],
  [
    'replaced method',
    'db(database).call(query, "read", input)',
    ['read.ts', 'export const query', 'Query.prototype.read = () => null; export const query'],
    'unknown',
  ],
  [
    'decorated method',
    'db(database).call(query, "read", input)',
    ['read.ts', 'read(input)', '@replace read(input)'],
    'unknown',
  ],
  [
    'opaque handler',
    'db(database).call(query, "read", input)',
    ['read.ts', 'return runQuery(input)', 'return fn(input)'],
    'unknown',
  ],
])('strictly resolves a database worker with %s', (_title, execute, edit, kind) => {
  const sources = new Map(workerSource);
  if (edit) {
    const [file, before, after] = edit;
    const path = `${dbDirectory}/${file}`;
    sources.set(path, sources.get(path)!.replace(before, after));
  }
  const source = `import { defineOperation } from './registry.ts';
    import { gatewayFor as db } from './db-gateway.ts';
    import { query } from './read.ts';
    defineOperation({ name: 'demo.read', execute: (input) => ${execute} });`;
  const path = `${dbDirectory}/route.ts`;
  sources.set(path, source);
  const resolve = createLocalPipelineResolver(source, path, true, sources);
  expect(resolve('demo.read')).toEqual(kind === 'named' ? { kind, name: 'demo.read' } : { kind });
});

test.each([
  ['registry replacement', "import { DB_OPS as registry } from './db-ops.ts'; registry.clear();"],
  [
    'command replacement',
    "import { query as command } from './read.ts'; command.Repository.prototype.read = () => null;",
  ],
  ['daemon alias', "import { DB_OPS } from '@/storage/db-gateway/db-ops'; DB_OPS.clear();"],
  ['namespace import', "import * as ops from './db-ops.ts'; ops.DB_OPS.clear();"],
  ['dynamic import', "void import('./db-ops').then((ops) => ops.DB_OPS.clear());"],
  ['re-export', "export { DB_OPS as registry } from './db-ops.ts';"],
])('leaves worker dispatch unknown after a cross-file %s', (_title, mutation) => {
  const path = `${dbDirectory}/route.ts`;
  const source = `import { defineOperation } from './registry.ts';
    import { gatewayFor as db } from './db-gateway.ts';
    import { query } from './read.ts';
    import './override.ts';
    defineOperation({ name: 'demo.read', execute: (input) => db(database).call(query, 'read', input) });`;
  const sources = new Map(workerSource)
    .set(path, source)
    .set(`${dbDirectory}/override.ts`, mutation);
  const input = new Map([[path, source]]);
  expect(countPipelineRoutes(input, true, sources)).toMatchObject({ unreadable: 1 });
  sources.set(
    `${dbDirectory}/override.ts`,
    "import type { DB_OPS } from './db-ops.ts'; import { anotherCommand } from './read.ts';"
  );
  expect(countPipelineRoutes(input, true, sources)).toMatchObject({ unreadable: 0 });
  sources.delete(`${dbDirectory}/db-gateway-worker.ts`);
  expect(countPipelineRoutes(input, true, sources)).toMatchObject({ unreadable: 1 });
});

test.each([
  ['another gateway call', 'db(database).call(query, "read", input);', 'named'],
  ['an alias', 'const alias = query;', 'unknown'],
  ['an unrelated call', 'mutate.call(query);', 'unknown'],
  ['a shadowed gateway', 'function db() {}', 'unknown'],
])('confines a command with %s', (_title, extra, kind) => {
  const path = `${dbDirectory}/route.ts`;
  const source = `import { defineOperation } from './registry.ts';
    import { gatewayFor as db } from './db-gateway.ts';
    import { query } from './read.ts';
    function other(input) { ${extra} }
    defineOperation({ name: 'demo.read', execute: (input) => db(database).call(query, 'read', input) });`;
  const sources = new Map(workerSource).set(path, source);
  expect(createLocalPipelineResolver(source, path, true, sources)('demo.read')).toEqual(
    kind === 'named' ? { kind, name: 'demo.read' } : { kind }
  );
});

test.each([
  ['registered DB operation', '[other]', 'named'],
  ['unregistered DB operation', '[]', 'unknown'],
])('strictly resolves a %s', (_title, registrations, kind) => {
  const path = `${dbDirectory}/route.ts`;
  const source = `import { defineOperation } from './registry.ts';
    import { gatewayFor as db } from './db-gateway.ts';
    import { other } from './other.ts';
    defineOperation({ name: 'demo.read', execute: (input) => db(database).run(other, input) });`;
  const registry = `import { other } from './other.ts';
    export const DB_OPS = new Map(${registrations}.map((op) => [op.name, op]));`;
  const sources = new Map(workerSource).set(path, source).set(`${dbDirectory}/db-ops.ts`, registry);
  const resolved = createLocalPipelineResolver(source, path, true, sources)('demo.read');
  expect(resolved).toEqual(
    kind === 'named' ? { kind, name: 'domain.query', terminal: true } : { kind }
  );
  expect(countPipelineRoutes(new Map([[path, source]]), true, sources)).toMatchObject(
    kind === 'named' ? { unreadable: 0, misnamed: 0 } : { unreadable: 1 }
  );
});
