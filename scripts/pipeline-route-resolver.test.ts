import { expect, test } from 'bun:test';
import { createLocalPipelineResolver } from './pipeline-route-resolver.ts';

const resolveLocalPipeline = (source: string, name: string) =>
  createLocalPipelineResolver(source)(name);

const imports = `
  import superpipe from 'superpipe';
  import { defineOperation } from './registry.ts';
`;
const runner = `const run = superpipe({})('demo.read').input('input').endAsync('input');`;

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
  ['competing recovery', serialQueue.replace('() => undefined);', '() => otherRun());'), 'unknown'],
])('strictly follows a queue with %s', (_title, queue, kind) => {
  const source = `${imports} ${runner} ${queue}
    defineOperation({ name: 'demo.read', execute: () => serialize(() => run()) });`;
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
