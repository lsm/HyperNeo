import { expect, test } from 'bun:test';
import { createLocalPipelineResolver } from './pipeline-route-resolver.ts';

const resolveLocalPipeline = (source: string, name: string) =>
  createLocalPipelineResolver(source)(name);

const imports = `
  import superpipe from 'superpipe';
  import { defineOperation } from './registry.ts';
`;
const runner = `const run = superpipe({})('demo.read').input('input').endAsync('input');`;

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
